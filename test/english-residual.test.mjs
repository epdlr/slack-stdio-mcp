/**
 * @file english-residual.test.mjs
 * @description Durable gate: residual Spanish must not re-enter the tree.
 *
 * Runs the same rules as `scripts/assert-english.mjs` so `npm test` always
 * enforces English-only prose (comments, strings, docs).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "assert-english.mjs");

describe("english residual gate (shipped)", () => {
  it("scripts/assert-english.mjs exits 0 (no residual Spanish)", () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
      assert.fail(
        `assert-english failed (exit ${result.status}):\n${detail || "(no output)"}`,
      );
    }
    assert.equal(result.status, 0);
    assert.match(result.stderr || "", /OK:.*0 residual Spanish/i);
  });
});
