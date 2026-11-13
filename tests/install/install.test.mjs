import assert from "node:assert/strict";
import { mkdir, mkdtemp, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { install } from "../../scripts/install.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ryuuaiskill-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, "repo");
  const targetRoot = join(root, "target");
  await write(join(repoRoot, "skills", "alpha", "SKILL.md"), "alpha v1\n");
  await write(join(repoRoot, "skills", "beta", "SKILL.md"), "beta v1\n");
  await write(join(repoRoot, "agents", "poteto-agent.md"), "agent v1\n");
  await write(join(repoRoot, "skills", "alpha", "node_modules", "dependency", "index.js"), "ignored\n");
  return { root, repoRoot, targetRoot };
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("fresh install excludes dependencies, preserves unrelated files, and is idempotent", async (t) => {
  const { repoRoot, targetRoot } = await fixture(t);
  await write(join(targetRoot, "skills", "unrelated", "SKILL.md"), "keep\n");

  const first = await install({ repoRoot, targetRoot });
  assert.equal(first.created, 3);
  assert.equal(first.updated, 0);
  assert.equal(await readFile(join(targetRoot, "skills", "alpha", "SKILL.md"), "utf8"), "alpha v1\n");
  assert.equal(await readFile(join(targetRoot, "skills", "unrelated", "SKILL.md"), "utf8"), "keep\n");
  assert.equal(await exists(join(targetRoot, "skills", "alpha", "node_modules")), false);

  const second = await install({ repoRoot, targetRoot });
  assert.deepEqual(second, { created: 0, updated: 0, unchanged: 3, backupPath: null });
});

test("conflicts fail before writes and force keeps a recovery backup", async (t) => {
  const { repoRoot, targetRoot } = await fixture(t);
  await install({ repoRoot, targetRoot });
  const customized = join(targetRoot, "skills", "alpha", "SKILL.md");
  await writeFile(customized, "local edit\n", "utf8");
  await write(join(repoRoot, "skills", "beta", "SKILL.md"), "beta v2\n");

  await assert.rejects(install({ repoRoot, targetRoot }), /Refusing to replace modified targets/);
  assert.equal(await readFile(customized, "utf8"), "local edit\n");
  assert.equal(await readFile(join(targetRoot, "skills", "beta", "SKILL.md"), "utf8"), "beta v1\n");

  const result = await install({ repoRoot, targetRoot, force: true });
  assert.equal(result.updated, 2);
  assert.ok(result.backupPath);
  assert.equal(await readFile(customized, "utf8"), "alpha v1\n");
  assert.equal(await readFile(join(targetRoot, "skills", "beta", "SKILL.md"), "utf8"), "beta v2\n");
  assert.equal(
    await readFile(join(result.backupPath, "backup", "skills", "alpha", "SKILL.md"), "utf8"),
    "local edit\n",
  );
  const manifest = JSON.parse(await readFile(join(result.backupPath, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "committed");
});

test("a mid-commit failure restores every original target and releases the lock", async (t) => {
  const { repoRoot, targetRoot } = await fixture(t);
  await install({ repoRoot, targetRoot });
  await write(join(repoRoot, "skills", "alpha", "SKILL.md"), "alpha v2\n");
  await write(join(repoRoot, "skills", "beta", "SKILL.md"), "beta v2\n");
  await write(join(repoRoot, "agents", "poteto-agent.md"), "agent v2\n");

  let stagedMoves = 0;
  const io = {
    async rename(oldPath, newPath) {
      if (oldPath.split(/[\\/]/).includes("new")) {
        stagedMoves += 1;
        if (stagedMoves === 2) throw new Error("injected commit failure");
      }
      return rename(oldPath, newPath);
    },
  };
  await assert.rejects(
    install({ repoRoot, targetRoot, force: true }, io),
    /all targets were rolled back/,
  );
  assert.equal(await readFile(join(targetRoot, "skills", "alpha", "SKILL.md"), "utf8"), "alpha v1\n");
  assert.equal(await readFile(join(targetRoot, "skills", "beta", "SKILL.md"), "utf8"), "beta v1\n");
  assert.equal(await readFile(join(targetRoot, "agents", "poteto-agent.md"), "utf8"), "agent v1\n");
  assert.deepEqual((await readdir(targetRoot)).sort(), ["agents", "skills"]);
});

test("an existing installation lock blocks concurrent writers", async (t) => {
  const { repoRoot, targetRoot } = await fixture(t);
  const lock = join(targetRoot, ".ryuuaiskill-install.lock");
  await mkdir(lock, { recursive: true });
  await assert.rejects(install({ repoRoot, targetRoot }), /Another installation is active/);
  assert.equal(await exists(join(targetRoot, "skills", "alpha", "SKILL.md")), false);
  assert.deepEqual(await readdir(lock), []);
  await rm(lock, { recursive: true, force: true });
  await install({ repoRoot, targetRoot });
  assert.equal(await readFile(join(targetRoot, "skills", "alpha", "SKILL.md"), "utf8"), "alpha v1\n");
});
