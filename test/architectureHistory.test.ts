import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const checker = fileURLToPath(new URL("../scripts/check-architecture.mjs", import.meta.url));
test("trusted PR/push history rejects a two-commit budget bypass and accepts reductions through merges", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "architecture-history-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "scripts"));
    const file = path.join(root, "scripts/architecture-baseline.json");
    const baseline = JSON.parse(
      readFileSync(new URL("../scripts/architecture-baseline.json", import.meta.url), "utf8")
    );
    baseline.moduleBudgets = { "src/large.ts": { baselineLines: 900, maxLines: 925, reason: "existing" } };
    const save = (lines: number) => {
      writeFileSync(file, JSON.stringify(baseline));
      writeFileSync(path.join(root, "src/large.ts"), "// line\n".repeat(lines));
    };
    save(900);
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("add", ".");
    git("commit", "-m", "accepted base");
    const accepted = git("rev-parse", "HEAD");
    git("switch", "-c", "feature");
    baseline.moduleBudgets["src/large.ts"].baselineLines = 950;
    baseline.moduleBudgets["src/large.ts"].maxLines = 975;
    save(950);
    git("add", ".");
    git("commit", "-m", "C1 raises budget");
    baseline.moduleBudgets["src/large.ts"].reason = "unrelated C2 metadata";
    save(950);
    git("add", ".");
    git("commit", "-m", "C2 metadata only");
    const event = path.join(root, "event.json");
    const run = (name: string, payload: object) => {
      writeFileSync(event, JSON.stringify(payload));
      return spawnSync(process.execPath, [checker, root], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: event },
      });
    };
    const pr = run("pull_request", { pull_request: { base: { sha: accepted } } });
    assert.equal(pr.status, 1, pr.stdout + pr.stderr);
    assert.match(pr.stderr, /budgets may not increase/);
    const local = spawnSync(process.execPath, [checker, root], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "false", ARCHITECTURE_BASE_REF: accepted },
    });
    assert.equal(local.status, 1);
    assert.match(local.stderr, /budgets may not increase/);
    const push = run("push", { ref: "refs/heads/main", before: accepted });
    assert.equal(push.status, 1, push.stdout + push.stderr);
    baseline.moduleBudgets["src/large.ts"] = { baselineLines: 880, maxLines: 905, reason: "reduced" };
    save(880);
    git("add", "src", "scripts");
    git("commit", "-m", "valid reduction");
    git("switch", "main");
    writeFileSync(path.join(root, "unrelated.txt"), "accepted unrelated change");
    git("add", "unrelated.txt");
    git("commit", "-m", "main advances");
    const nextBase = git("rev-parse", "HEAD");
    git("switch", "feature");
    git("merge", "--no-ff", "main", "-m", "ordinary fixture merge");
    const valid = run("pull_request", { pull_request: { base: { sha: nextBase } } });
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.equal(run("push", { ref: "refs/heads/main", before: accepted }).status, 0);
    assert.equal(run("pull_request", { pull_request: { base: { sha: "f".repeat(40) } } }).status, 1);
    assert.equal(run("push", { ref: "refs/heads/main", before: "0".repeat(40) }).status, 1);
    assert.equal(run("pull_request", {}).status, 1);
    assert.equal(run("workflow_dispatch", {}).status, 1);
    const shallow = path.join(root, "shallow");
    execFileSync("git", ["clone", "--depth", "1", pathToFileURL(root).href, shallow], { stdio: "ignore" });
    const missingHistory = spawnSync(process.execPath, [checker, shallow], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event },
    });
    assert.equal(missingHistory.status, 1);
    assert.match(missingHistory.stderr, /full Git history/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
