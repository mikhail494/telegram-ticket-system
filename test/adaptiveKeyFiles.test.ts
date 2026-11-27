import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadAdaptivePrivacy } from "../src/adaptivePrivacy.js";
import { secureAdaptiveKeyPath } from "../src/adaptiveKeyFiles.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-path-"));
  return { directory, key: path.join(directory, "private", "adaptive.key") };
}

test("trusted parent symlinks/junctions use the canonical private directory and detect replacement", () => {
  const f = fixture();
  try {
    const privacy = loadAdaptivePrivacy("unused.db", f.key);
    const alias = path.join(f.directory, "alias");
    fs.symlinkSync(f.directory, alias, process.platform === "win32" ? "junction" : "dir");
    const linked = path.join(alias, "private", "adaptive.key");
    assert.equal(loadAdaptivePrivacy("unused.db", linked, privacy.keyId).keyId, privacy.keyId);
    const secured = secureAdaptiveKeyPath(linked);
    fs.unlinkSync(alias);
    const other = path.join(f.directory, "other");
    fs.mkdirSync(other, { mode: 0o700 });
    fs.symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
    assert.throws(secured.verify);
    assert.equal(fs.existsSync(path.join(other, "private")), false);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("untrusted writable ancestors are rejected before key creation, including through an alias", () => {
  const f = fixture();
  try {
    if (process.platform === "win32")
      execFileSync("icacls.exe", [f.directory, "/grant", "*S-1-1-0:(OI)(CI)M"], { stdio: "ignore" });
    else fs.chmodSync(f.directory, 0o777);
    assert.throws(() => loadAdaptivePrivacy("unused.db", f.key), /Unsafe|permissions/);
    assert.equal(fs.existsSync(f.key), false);
    assert.equal(fs.existsSync(path.dirname(f.key)), false);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a trusted target does not make an attacker-writable symlink namespace safe", () => {
  const f = fixture();
  const unsafe = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-unsafe-alias-"));
  try {
    loadAdaptivePrivacy("unused.db", f.key);
    const alias = path.join(unsafe, "alias");
    fs.symlinkSync(f.directory, alias, process.platform === "win32" ? "junction" : "dir");
    if (process.platform === "win32")
      execFileSync("icacls.exe", [unsafe, "/grant", "*S-1-1-0:(OI)(CI)M"], { stdio: "ignore" });
    else fs.chmodSync(unsafe, 0o777);
    assert.throws(
      () => loadAdaptivePrivacy("unused.db", path.join(alias, "private", "adaptive.key")),
      /Unsafe|permissions/
    );
  } finally {
    fs.rmSync(unsafe, { recursive: true, force: true });
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("a final key symlink is never followed", (t) => {
  const f = fixture();
  try {
    const original = loadAdaptivePrivacy("unused.db", f.key);
    const target = path.join(path.dirname(f.key), "retained.key");
    fs.renameSync(f.key, target);
    try {
      fs.symlinkSync(target, f.key, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Windows file-symlink creation privilege unavailable; junction coverage runs separately.");
        return;
      }
      throw error;
    }
    assert.throws(() => loadAdaptivePrivacy("unused.db", f.key, original.keyId), /Unsafe adaptive key file/);
    assert.equal(fs.readFileSync(target).length, 32);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("trusted aliases cannot hide an untrusted intermediate symlink/junction target", () => {
  const f = fixture();
  const unsafe = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-hidden-hop-"));
  try {
    const privacy = loadAdaptivePrivacy("unused.db", f.key);
    const hop = path.join(unsafe, "hop");
    const alias = path.join(f.directory, "trusted-alias");
    const kind = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(path.dirname(f.key), hop, kind);
    fs.symlinkSync(hop, alias, kind);
    assert.equal(
      loadAdaptivePrivacy("unused.db", path.join(alias, "adaptive.key"), privacy.keyId).keyId,
      privacy.keyId
    );
    if (process.platform === "win32")
      execFileSync("icacls.exe", [unsafe, "/grant", "*S-1-1-0:(OI)(CI)M"], { stdio: "ignore" });
    else fs.chmodSync(unsafe, 0o777);
    assert.throws(
      () => loadAdaptivePrivacy("unused.db", path.join(alias, "adaptive.key"), privacy.keyId),
      /Unsafe|permissions/
    );
  } finally {
    fs.rmSync(unsafe, { recursive: true, force: true });
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});

test("concurrent processes publish exactly one complete installation key", async () => {
  const f = fixture();
  try {
    const module = new URL("../src/adaptivePrivacy.ts", import.meta.url).href;
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const script = `import { loadAdaptivePrivacy } from ${JSON.stringify(module)}; console.log(loadAdaptivePrivacy("unused.db", process.argv[1]).keyId);`;
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, f.key], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (errors += chunk));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(errors))));
      });
    const identities = await Promise.all([run(), run(), run()]);
    assert.match(identities[0]!, /^[a-f0-9]{64}$/);
    assert.equal(new Set(identities).size, 1);
    assert.equal(fs.readFileSync(f.key).length, 32);
    assert.equal(fs.lstatSync(f.key).nlink, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(f.key)), ["adaptive.key"]);
  } finally {
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
