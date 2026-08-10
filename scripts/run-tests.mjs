#!/usr/bin/env node
// Cross-platform test runner for `node --test`.
// Node 20 does not expand shell globs passed to the test runner (they become
// a literal path). Listing files here works on Windows, macOS, Linux, Node 20+.


import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");

const entries = await readdir(testDir);
const files = entries
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => path.join(testDir, name))
  .sort();

if (files.length === 0) {
  console.error(`[run-tests] No *.test.mjs files under ${testDir}`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  cwd: root,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
