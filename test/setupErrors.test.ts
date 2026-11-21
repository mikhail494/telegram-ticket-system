import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { runSetup } from "../src/setup.js";

test("setup rejects malformed tokens before API access and preserves existing configuration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "setup-reject-"));
  const file = path.join(directory, ".env");
  const original = "BOT_TOKEN=123456:EXISTING_TEST_TOKEN\r\nCUSTOM=keep\r\n";
  try {
    await writeFile(file, original);
    await assert.rejects(
      () =>
        runSetup({
          env: { BOT_TOKEN: "bad" },
          envPath: file,
          confirmOverwrite: async () => true,
          verifyToken: async () => {
            assert.fail("no API for malformed token");
          },
        }),
      /invalid format/
    );
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const failure of ["network", "invalid-json", "rejected", "missing-identity", "success"] as const) {
  test(`setup real getMe adapter handles ${failure} without printing credentials`, async () => {
    const token = "123456:SYNTHETIC_PRIVATE_TOKEN";
    const output: string[] = [];
    const fetch = mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new Error(`request failed bot${token}/getMe`);
      if (failure === "invalid-json") return new Response("not JSON");
      if (failure === "rejected")
        return new Response(JSON.stringify({ ok: false, description: token }), { status: 401 });
      return new Response(
        JSON.stringify({ ok: true, result: failure === "success" ? { id: 77, username: "fixture_bot" } : {} })
      );
    });
    try {
      const operation = () =>
        runSetup({ env: { BOT_TOKEN: token }, envPath: false, writeOutput: (line) => output.push(line) });
      if (failure === "success") assert.equal((await operation()).botId, 77);
      else
        await assert.rejects(
          operation,
          (error) =>
            error instanceof Error && /verification failed/.test(error.message) && !error.message.includes(token)
        );
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(output.join("\n").includes(token), false);
    } finally {
      fetch.mock.restore();
    }
  });
}

test("setup write/rename failures retain prior data and remove only their own temporary secret file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "setup-write-"));
  const file = path.join(directory, ".env");
  const token = "123456:SYNTHETIC_PRIVATE_TOKEN";
  try {
    await assert.rejects(
      () =>
        runSetup({
          env: { BOT_TOKEN: token },
          envPath: path.join(directory, "missing", ".env"),
          verifyToken: async () => ({ id: 1, username: "test" }),
          writeOutput: () => undefined,
        }),
      /could not be saved/
    );
    await writeFile(file, `BOT_TOKEN=${token}\nCUSTOM=keep\n`);
    const original = await readFile(file, "utf8");
    await writeFile(`${file}.${process.pid}.tmp`, "other invocation");
    await assert.rejects(
      () =>
        runSetup({
          env: {},
          envPath: file,
          verifyToken: async () => ({ id: 1, username: "test" }),
          writeOutput: () => undefined,
        }),
      /could not be saved/
    );
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(await readFile(`${file}.${process.pid}.tmp`, "utf8"), "other invocation");
    await rm(`${file}.${process.pid}.tmp`);
    await rm(file);
    await assert.rejects(
      () =>
        runSetup({
          env: { BOT_TOKEN: token },
          envPath: file,
          verifyToken: async () => {
            await mkdir(file);
            await writeFile(path.join(file, "keep"), "safe");
            return { id: 1, username: "test" };
          },
          writeOutput: () => undefined,
        }),
      /could not be saved/
    );
    assert.equal(await readFile(path.join(file, "keep"), "utf8"), "safe");
    assert.deepEqual(await readdir(directory), [".env"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
