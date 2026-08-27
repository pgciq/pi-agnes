import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(projectRoot, "extensions", "agnes.ts");

function listModels() {
  return execFileSync(
    "pi",
    ["--no-extensions", "-e", extension, "--offline", "--list-models", "agnes"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        AGNES_API_KEY: "test-key",
        AGNES_CN_API_KEY: "test-key",
      },
    },
  );
}

test("package exposes the Pi extension", () => {
  const packageJson = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8"),
  );

  assert.equal(packageJson.scripts.test, "node --test");
  assert.deepEqual(packageJson.pi.extensions, ["./extensions"]);
  assert.equal(existsSync(extension), true);
});

test("extension registers both Agnes providers and seed models", () => {
  const output = listModels();

  for (const provider of ["agnes", "agnes-cn"]) {
    assert.match(output, new RegExp(`^${provider}\\s`, "m"));
    for (const model of [
      "agnes-2.5-flash",
      "agnes-2.5-pro",
      "agnes-2.0-flash",
    ]) {
      assert.match(output, new RegExp(`^${provider}\\s+${model}\\s`, "m"));
    }
  }
});
