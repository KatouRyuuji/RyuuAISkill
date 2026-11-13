#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const groups = ["skills", "agents"];
const excluded = new Set(["node_modules"]);

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function hashTree(path) {
  const hash = createHash("sha256");
  async function visit(current, name) {
    if (!(await exists(current))) {
      hash.update(`missing:${name}`);
      return;
    }
    const info = await lstat(current);
    hash.update(`${info.isDirectory() ? "dir" : info.isSymbolicLink() ? "link" : "file"}:${name}\0`);
    if (info.isSymbolicLink()) {
      hash.update(await readlink(current));
    } else if (info.isDirectory()) {
      const entries = await readdir(current);
      entries.sort();
      for (const entry of entries) {
        if (!excluded.has(entry)) await visit(join(current, entry), `${name}/${entry}`);
      }
    } else {
      hash.update(await readFile(current));
    }
    hash.update("\0");
  }
  await visit(path, "");
  return hash.digest("hex");
}

async function collectItems(repoRoot, targetRoot) {
  const items = [];
  for (const group of groups) {
    const sourceRoot = join(repoRoot, group);
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const source = join(sourceRoot, entry.name);
      const target = join(targetRoot, group, entry.name);
      const present = await exists(target);
      const unchanged = present && (await hashTree(source)) === (await hashTree(target));
      items.push({ group, name: entry.name, source, target, present, unchanged });
    }
  }
  return items;
}

async function copyStaged(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (path) => !path.split(/[\\/]/).some((part) => excluded.has(part)),
  });
}

function displayPath(targetRoot, path) {
  return relative(targetRoot, path).split(sep).join("/");
}

export async function install(
  { repoRoot, targetRoot, force = false },
  io = { rename },
) {
  const items = await collectItems(repoRoot, targetRoot);
  const pending = items.filter((item) => !item.unchanged);
  if (pending.length === 0) {
    return { created: 0, updated: 0, unchanged: items.length, backupPath: null };
  }

  const conflicts = pending.filter((item) => item.present);
  if (conflicts.length > 0 && !force) {
    const names = conflicts.map((item) => displayPath(targetRoot, item.target)).join(", ");
    throw new Error(`Refusing to replace modified targets: ${names}. Review them, then rerun with --force to create a backup and update.`);
  }

  await mkdir(targetRoot, { recursive: true });
  const lock = join(targetRoot, ".ryuuaiskill-install.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Another installation is active or left a lock at ${lock}. Inspect it before retrying.`);
    }
    throw error;
  }

  let transaction = null;
  try {
    transaction = await mkdtemp(join(targetRoot, ".ryuuaiskill-transaction-"));
    const manifestPath = join(transaction, "manifest.json");
    const operations = pending.map((item) => ({
      item,
      staged: join(transaction, "new", item.group, item.name),
      backup: join(transaction, "backup", item.group, item.name),
      originalMoved: false,
      newMoved: false,
    }));
    for (const operation of operations) await copyStaged(operation.item.source, operation.staged);

    const manifest = {
      source: repoRoot,
      targetRoot,
      createdAt: new Date().toISOString(),
      status: "staged",
      items: pending.map((item) => displayPath(targetRoot, item.target)),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    let backups = 0;
    try {
      manifest.status = "applying";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      for (const operation of operations) {
        const { item, staged, backup } = operation;
        await mkdir(dirname(item.target), { recursive: true });
        if (await exists(item.target)) {
          await mkdir(dirname(backup), { recursive: true });
          await io.rename(item.target, backup);
          operation.originalMoved = true;
          backups += 1;
        }
        await io.rename(staged, item.target);
        operation.newMoved = true;
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const operation of [...operations].reverse()) {
        try {
          if (operation.newMoved) await rm(operation.item.target, { recursive: true, force: true });
          if (operation.originalMoved) await io.rename(operation.backup, operation.item.target);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length === 0) {
        await rm(transaction, { recursive: true, force: true });
        transaction = null;
        throw new Error("Installation failed; all targets were rolled back.", { cause: error });
      }
      manifest.status = "rollback-failed";
      manifest.rollbackErrors = rollbackErrors.map(String);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      throw new Error(`Installation and rollback failed. Recovery files are at ${transaction}.`, { cause: error });
    }

    manifest.status = "committed";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const backupPath = backups > 0 ? transaction : null;
    if (backupPath === null) {
      await rm(transaction, { recursive: true, force: true });
      transaction = null;
    } else {
      await rm(join(transaction, "new"), { recursive: true, force: true });
    }
    return {
      created: operations.filter((operation) => !operation.originalMoved).length,
      updated: operations.filter((operation) => operation.originalMoved).length,
      unchanged: items.length - pending.length,
      backupPath,
    };
  } finally {
    if (transaction !== null && !(await exists(join(transaction, "manifest.json")))) {
      await rm(transaction, { recursive: true, force: true });
    }
    await rm(lock, { recursive: true, force: true });
  }
}

function usage() {
  return "Usage: node scripts/install.mjs --target <agent-config-directory> [--force]\n\nInstalls all skills and agents, excluding node_modules. Existing modified targets are refused unless --force is set; forced updates keep a backup.";
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  let targetRoot = null;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--target" && targetRoot === null) {
      targetRoot = args[++index];
      if (targetRoot === undefined || targetRoot.startsWith("--")) throw new Error("--target requires a directory");
    } else if (args[index] === "--force") {
      force = true;
    } else {
      throw new Error(`Unknown argument: ${args[index]}\n${usage()}`);
    }
  }
  if (targetRoot === null) throw new Error(usage());
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const result = await install({
    repoRoot: resolve(scriptDirectory, ".."),
    targetRoot: resolve(targetRoot),
    force,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
