import { constants } from "node:fs";
import { access, chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import dotenv from "dotenv";

interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  envPath?: string | false;
  interactive?: boolean;
  promptToken?: () => Promise<string>;
  confirmOverwrite?: () => Promise<boolean>;
  verifyToken?: (token: string) => Promise<{ id: number; username: string }>;
  writeOutput?: (line: string) => void;
}

function updateEnvContents(contents: string, existing: Record<string, string>, values: Record<string, string | undefined>): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.length === 0 ? [] : contents.split(/\r?\n/);
  if (contents.endsWith("\n")) lines.pop();

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const serialized = /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const assignment = new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=`);
    const assignmentCount = lines.filter((line) => assignment.test(line)).length;
    if (existing[key] === value && assignmentCount <= 1) continue;
    let replaced = false;
    for (let index = 0; index < lines.length;) {
      if (!assignment.test(lines[index]!)) { index += 1; continue; }
      if (!replaced) {
        lines[index] = `${key}=${serialized}`;
        replaced = true;
        index += 1;
      } else {
        lines.splice(index, 1);
      }
    }
    if (!replaced) lines.push(`${key}=${serialized}`);
  }

  return `${lines.join(newline)}${newline}`;
}

async function exists(file: string): Promise<boolean> { try { await access(file, constants.F_OK); return true; } catch { return false; } }

async function hiddenPrompt(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("BOT_TOKEN is missing in non-interactive mode. Set it in the environment or run npm run setup in a terminal.");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write("Bot token (input hidden): ");
    const mutable = rl as readline.Interface & { _writeToOutput?: (value: string) => void };
    const original = mutable._writeToOutput;
    mutable._writeToOutput = () => undefined;
    rl.question("", (answer) => { mutable._writeToOutput = original; rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

async function confirmTokenOverwrite(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => prompt.question("A different BOT_TOKEN is already saved. Replace it? Type REPLACE: ", resolve));
  prompt.close();
  return answer.trim() === "REPLACE";
}

async function verifyWithTelegram(token: string): Promise<{ id: number; username: string }> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const body = await response.json() as { ok?: boolean; result?: { id?: number; username?: string }; description?: string };
  if (!response.ok || !body.ok || !body.result?.id || !body.result.username) throw new Error(`Telegram rejected the bot token: ${body.description ?? response.statusText}`);
  return { id: body.result.id, username: body.result.username };
}

export async function runSetup(options: SetupOptions = {}): Promise<{ botId: number; botUsername: string; envPath: string | null }> {
  const env = options.env ?? process.env;
  const envPath = options.envPath === undefined ? path.resolve(process.cwd(), ".env") : options.envPath;
  let existingContents = "";
  let existing: Record<string, string> = {};
  if (envPath && await exists(envPath)) {
    existingContents = await readFile(envPath, "utf8");
    existing = dotenv.parse(existingContents);
  }
  let token = env.BOT_TOKEN?.trim() || existing.BOT_TOKEN?.trim();
  let tokenToPersist = token;
  if (!token) {
    if (options.interactive === false) throw new Error("BOT_TOKEN is missing in non-interactive mode. Set it in the environment or run npm run setup in a terminal.");
    token = (await (options.promptToken ?? hiddenPrompt)()).trim();
  } else if (env.BOT_TOKEN && existing.BOT_TOKEN && env.BOT_TOKEN !== existing.BOT_TOKEN) {
    const overwrite = await (options.confirmOverwrite ?? confirmTokenOverwrite)();
    tokenToPersist = overwrite ? token : existing.BOT_TOKEN;
  }
  if (!/^\d{5,}:[A-Za-z0-9_-]{10,}$/.test(token)) throw new Error("BOT_TOKEN has an invalid format. Paste the complete token from BotFather.");
  const identity = await (options.verifyToken ?? verifyWithTelegram)(token);
  const output = options.writeOutput ?? console.log;
  output(`Verified bot: @${identity.username} (${identity.id})`);
  if (envPath) {
    const values = { ...existing, BOT_TOKEN: tokenToPersist ?? token, DATABASE_URL: env.DATABASE_URL ?? existing.DATABASE_URL ?? "file:./data/support.db", LOG_LEVEL: env.LOG_LEVEL ?? existing.LOG_LEVEL ?? "info" };
    const contents = updateEnvContents(existingContents, existing, values);
    const temporary = `${envPath}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, envPath);
    try { await chmod(envPath, 0o600); } catch { /* Windows may not implement POSIX modes. */ }
  }
  output("Local configuration is ready.");
  return { botId: identity.id, botUsername: identity.username, envPath: envPath || null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runSetup().catch((error) => { console.error(error instanceof Error ? error.message : "Setup failed."); process.exitCode = 1; });
}
