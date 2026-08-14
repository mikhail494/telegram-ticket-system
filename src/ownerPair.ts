import readline from "node:readline/promises";
import { Bot } from "grammy";
import { config } from "./config.js";
import { SupportDatabase } from "./db.js";
import { InstallationService } from "./installation.js";

export async function runOwnerPair(options: { interactive?: boolean; confirm?: () => Promise<string>; getUsername?: () => Promise<string>; write?: (line: string) => void; openDatabase?: () => SupportDatabase } = {}): Promise<void> {
  const interactive = options.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
  if (!interactive) throw new Error("Owner pairing requires an interactive terminal confirmation.");
  let prompt: readline.Interface | undefined;
  const confirm = options.confirm ?? (async () => {
    prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    return prompt.question("Create a one-use OWNER pairing link? Type PAIR: ");
  });
  const answer = await confirm();
  prompt?.close();
  if (answer.trim() !== "PAIR") throw new Error("Owner pairing cancelled.");
  const injectedDatabase = options.openDatabase?.();
  const db = injectedDatabase ?? new SupportDatabase(config.databaseUrl);
  try {
    const service = new InstallationService(db);
    if (service.getOwner()) throw new Error("An OWNER already exists. Use npm run owner:recover for a transfer.");
    const username = options.getUsername ? await options.getUsername() : (await new Bot(config.botToken).api.getMe()).username;
    const token = service.createOwnerPairingToken();
    (options.write ?? console.log)(`Open this one-use link within 30 minutes: https://t.me/${username}?start=setup_${token}`);
  } finally { if (!injectedDatabase) db.close(); }
}

if (process.argv[1]?.endsWith("ownerPair.ts")) runOwnerPair().catch((error) => { console.error(error instanceof Error ? error.message : "Owner pairing failed."); process.exitCode = 1; });
