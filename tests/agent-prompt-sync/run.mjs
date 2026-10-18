import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../../skills/agent-prompt-sync/scripts/prompt-sync.mjs");
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function invoke(args, expectedStatus = 0, environment = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
  assert.equal(
    result.status,
    expectedStatus,
    `Unexpected exit status.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}

function outputJson(result) {
  return JSON.parse(result.stdout);
}

function paths(home) {
  const stateRoot = join(home, ".agent-prompt-sync");
  return {
    stateRoot,
    lock: join(stateRoot, "lock"),
    canonical: join(home, ".claude", "CLAUDE.md"),
    claudeDelta: join(home, ".claude", "rules", "agent-prompt-sync.md"),
    codexComposite: join(stateRoot, "generated", "codex", "AGENTS.md"),
    codexBase: join(home, ".codex", "AGENTS.md"),
    codexOverride: join(home, ".codex", "AGENTS.override.md"),
    cursorCanonical: join(stateRoot, "generated", "cursor", "ryuuji.mdc"),
    cursorCanonicalEntry: join(home, ".cursor", "rules", "ryuuji.mdc"),
    cursorDelta: join(home, ".cursor", "rules", "agent-prompt-sync.mdc"),
    cursorLegacy: join(home, ".cursor", "AGENTS.md"),
    opencodeCanonical: join(stateRoot, "generated", "opencode", "AGENTS.md"),
    opencodeEntry: join(home, ".config", "opencode", "AGENTS.md"),
    opencodeDelta: join(home, ".config", "opencode", "rules", "agent-prompt-sync.md"),
    opencodeConfig: join(home, ".config", "opencode", "opencode.json"),
    opencodeConfigJsonc: join(home, ".config", "opencode", "opencode.jsonc"),
    cursorAccountDb: join(home, ".cursor", "User", "globalStorage", "state.vscdb"),
  };
}

async function writeCursorAccountRules(dbPath, value) {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(
      "aicontext.personalContext",
      value,
    );
  } finally {
    db.close();
  }
}

async function fixture() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-prompt-sync-test-"));
  const home = join(temporaryRoot, "home");
  const templatePath = join(temporaryRoot, "template.md");
  const template = "# Ryuuji\n\nKeep the shared rules.\n";
  await mkdir(home, { recursive: true });
  await writeFile(templatePath, template, "utf8");
  return {
    temporaryRoot,
    home,
    paths: paths(home),
    templatePath,
    template,
    inventory: join(temporaryRoot, "inventory.json"),
    plan: join(temporaryRoot, "plan.json"),
  };
}

async function completeScaffold(context) {
  outputJson(invoke([
    "scaffold",
    "--inventory",
    context.inventory,
    "--output",
    context.plan,
  ]));
  const plan = await readJson(context.plan);
  for (const item of plan.analysis) item.rationale = "Existing rules reviewed";
  await writeJson(context.plan, plan);
  return plan;
}

async function scan(context) {
  return outputJson(invoke([
    "scan",
    "--root",
    context.home,
    "--template",
    context.templatePath,
    "--output",
    context.inventory,
  ]));
}

async function scanAndScaffold(context) {
  await scan(context);
  return completeScaffold(context);
}

async function preview(context, expectedStatus = 0) {
  return outputJson(invoke(["preview", "--plan", context.plan], expectedStatus));
}

async function previewReport(result) {
  assert.equal(result.report, undefined);
  assert.equal(result.branches, undefined);
  assert.equal(result.excludedAgents, undefined);
  return readFile(result.reportPath, "utf8");
}

async function apply(context, branch, digest, expectedStatus = 0, environment = {}) {
  return invoke([
    "apply",
    "--plan",
    context.plan,
    "--branch",
    branch,
    "--confirm",
    digest,
  ], expectedStatus, environment);
}

async function capture(path, includeFileId = false) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    return { kind: "symlink", target: await readlink(path) };
  }
  if (!metadata.isFile()) return { kind: metadata.isDirectory() ? "directory" : "other" };
  const result = { kind: "file", content: (await readFile(path)).toString("base64") };
  if (includeFileId) result.fileId = `${metadata.dev}:${metadata.ino}`;
  return result;
}

async function captureManaged(context, includeFileId = false) {
  const result = {};
  for (const [role, path] of Object.entries(context.paths)) {
    if (["stateRoot", "lock"].includes(role)) continue;
    result[role] = await capture(path, includeFileId);
  }
  result.template = await capture(context.templatePath, includeFileId);
  return result;
}

async function assertLink(path, target) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    assert.equal(resolve(dirname(path), await readlink(path)), target);
    return "symlink";
  }
  assert.equal(metadata.isFile(), true, `${path} is not a file or symlink`);
  const targetMetadata = await stat(target);
  assert.equal(metadata.dev, targetMetadata.dev);
  assert.equal(metadata.ino, targetMetadata.ino);
  assert.deepEqual(await readFile(path), await readFile(target));
  return "hardlink";
}

async function setupAll(context, current = "# Current\n\nRemove this.\n") {
  const p = context.paths;
  await mkdir(dirname(p.canonical), { recursive: true });
  await mkdir(dirname(p.codexBase), { recursive: true });
  await mkdir(dirname(p.cursorLegacy), { recursive: true });
  await mkdir(dirname(p.opencodeEntry), { recursive: true });
  await writeFile(p.canonical, current, "utf8");
  await writeFile(p.codexBase, current, "utf8");
  await writeFile(p.cursorLegacy, current, "utf8");
  await writeFile(p.opencodeEntry, "# OpenCode\n\nKeep agent routing.\n", "utf8");
  await writeJson(p.opencodeConfig, {
    mcp: {},
    $schema: "https://opencode.ai/config.json",
    plugin: ["context-mode"],
  });
}

function compose(canonical, increment) {
  if (!increment) return canonical;
  return `${canonical}${canonical.endsWith("\n") ? "\n" : "\n\n"}${increment}`;
}

async function assertAbsent(path) {
  assert.equal((await capture(path)).kind, "absent", `${path} should be absent`);
}

test("scan ignores empty directories and inventories all supported prompt layouts", async () => {
  const context = await fixture();
  try {
    await mkdir(dirname(context.paths.codexBase), { recursive: true });
    await mkdir(dirname(context.paths.cursorLegacy), { recursive: true });
    const empty = await scan(context);
    assert.deepEqual(empty.agents, []);
    assert.deepEqual(empty.excludedAgents, []);
    assert.deepEqual(empty.warnings, []);

    await setupAll(context);
    await writeFile(context.paths.codexOverride, "# Override\n", "utf8");
    await mkdir(dirname(context.paths.cursorDelta), { recursive: true });
    await writeFile(context.paths.cursorDelta, "---\nalwaysApply: true\n---\n\n# Existing\n", "utf8");
    const result = await scan(context);
    assert.deepEqual(result.agents, ["claude-code", "codex", "cursor", "opencode"]);
    assert.equal(result.warnings[0]?.code, "cursor-account-user-rules");
    const inventory = await readJson(context.inventory);
    assert.equal(inventory.states.codexOverride.content, "# Override\n");
    assert.equal(inventory.states.cursorLegacy.content, "# Current\n\nRemove this.\n");
    assert.equal(inventory.states.opencodeConfig.textValid, true);
    assert.equal(inventory.states.codexComposite.content, null);
    assert.equal(inventory.states.cursorCanonical.content, null);
    assert.equal(inventory.states.opencodeCanonical.content, null);
    const plan = await completeScaffold(context);
    assert.deepEqual(Object.keys(plan.branches.A), ["claude-code", "codex", "cursor", "opencode"]);
    assert.deepEqual(Object.values(plan.branches.A), ["", "", "", ""]);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("A applies canonical links, removes legacy Cursor input, and retries with zero changes", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    const configBefore = await readFile(context.paths.opencodeConfig, "utf8");
    await scanAndScaffold(context);
    const dryRun = await preview(context);
    assert.equal(dryRun.valid, true);
    const applied = outputJson(await apply(context, "A", dryRun.planDigest));
    const p = context.paths;

    assert.equal(await readFile(p.canonical, "utf8"), context.template);
    assertAbsent(p.claudeDelta);
    assert.equal(await readFile(p.codexComposite, "utf8"), context.template);
    await assertLink(p.codexBase, p.codexComposite);
    assertAbsent(p.codexOverride);
    assert.equal(await readFile(p.cursorCanonical, "utf8"), `---\nalwaysApply: true\n---\n\n${context.template}`);
    await assertLink(p.cursorCanonicalEntry, p.cursorCanonical);
    assertAbsent(p.cursorDelta);
    assertAbsent(p.cursorLegacy);
    await assertLink(p.opencodeEntry, p.opencodeCanonical);
    assert.equal(await readFile(p.opencodeCanonical, "utf8"), context.template);
    assert.equal((await stat(p.canonical)).nlink, 1);
    assertAbsent(p.opencodeDelta);
    assert.equal(await readFile(p.opencodeConfig, "utf8"), configBefore);

    const manifest = await readJson(join(applied.backup, "manifest.json"));
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.operations.find((item) => item.role === "cursorLegacy").action, "delete");
    const repeated = outputJson(await apply(context, "A", dryRun.planDigest));
    assert.equal(repeated.changed, 0);
    assert.equal(repeated.backup, null);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("preview is read-only and C applies only increments before a later A removes them", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    await writeJson(context.paths.opencodeConfig, {
      mcp: { existing: true },
      plugin: ["context-mode"],
      instructions: ["docs/existing.md"],
    });
    const plan = await scanAndScaffold(context);
    const increments = {
      "claude-code": "# Claude increment\n",
      codex: "# Codex increment\n",
      cursor: "# Cursor increment\n",
      opencode: "# OpenCode increment\n",
    };
    Object.assign(plan.branches.C, increments);
    plan.recommendation = "C";
    await writeJson(context.plan, plan);

    const beforePreview = await captureManaged(context, true);
    const dryRun = await preview(context);
    assert.equal(dryRun.valid, true);
    assert.deepEqual(await captureManaged(context, true), beforePreview);
    const report = await previewReport(dryRun);
    assert.match(report, /Recommendation: C/);
    assert.match(report, /A: \(empty\)/);
    assert.match(report, /# Claude increment/);
    assert.match(report, /Branch C — \d+ changes/);
    assert.match(report, /\+# Claude increment/);
    const branchA = Number(report.match(/## Branch A — (\d+) change/)[1]);
    const branchC = Number(report.match(/## Branch C — (\d+) change/)[1]);
    assert.ok(branchC > branchA);
    const applied = outputJson(await apply(context, "C", dryRun.planDigest));
    const p = context.paths;

    assert.equal(await readFile(p.claudeDelta, "utf8"), increments["claude-code"]);
    assert.equal(await readFile(p.codexComposite, "utf8"), compose(context.template, increments.codex));
    assert.equal(await readFile(p.cursorDelta, "utf8"), `---\nalwaysApply: true\n---\n\n${increments.cursor}`);
    assert.equal(await readFile(p.opencodeDelta, "utf8"), increments.opencode);
    const config = await readJson(p.opencodeConfig);
    assert.deepEqual(config.mcp, { existing: true });
    assert.deepEqual(config.plugin, ["context-mode"]);
    assert.deepEqual(config.instructions, ["docs/existing.md", p.opencodeDelta]);
    assert.ok(applied.backup);

    await scanAndScaffold(context);
    const afterApply = await readJson(context.inventory);
    assert.equal(afterApply.states.codexComposite.content, null);
    assert.equal(typeof afterApply.states.codexComposite.sha256, "string");
    assert.equal(afterApply.states.claudeDelta.content, increments["claude-code"]);
    const secondPreview = await preview(context);
    outputJson(await apply(context, "A", secondPreview.planDigest));
    await assertAbsent(p.claudeDelta);
    await assertAbsent(p.cursorDelta);
    await assertAbsent(p.opencodeDelta);
    assert.equal(await readFile(p.codexComposite, "utf8"), context.template);
    assert.deepEqual((await readJson(p.opencodeConfig)).instructions, ["docs/existing.md"]);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("Codex links every existing global entry to one composite without creating alternatives", async () => {
  for (const withBase of [false, true]) {
    const context = await fixture();
    try {
      const p = context.paths;
      await mkdir(dirname(p.canonical), { recursive: true });
      await mkdir(dirname(p.codexOverride), { recursive: true });
      await writeFile(p.canonical, context.template, "utf8");
      await writeFile(p.codexOverride, "# Override\n", "utf8");
      if (withBase) await writeFile(p.codexBase, "# Base\n", "utf8");
      await scanAndScaffold(context);
      const dryRun = await preview(context);
      outputJson(await apply(context, "A", dryRun.planDigest));
      await assertLink(p.codexOverride, p.codexComposite);
      if (withBase) await assertLink(p.codexBase, p.codexComposite);
      else await assertAbsent(p.codexBase);
      assert.equal(await readFile(p.codexOverride, "utf8"), context.template);
    } finally {
      await rm(context.temporaryRoot, { recursive: true, force: true });
    }
  }
});

test("canonical replacement refreshes a Windows hardlink and preserves POSIX symlink targets", async () => {
  const context = await fixture();
  try {
    const p = context.paths;
    await mkdir(dirname(p.canonical), { recursive: true });
    await mkdir(dirname(p.opencodeEntry), { recursive: true });
    await writeFile(p.canonical, context.template, "utf8");
    await writeFile(p.opencodeEntry, context.template, "utf8");
    await scanAndScaffold(context);
    const firstPreview = await preview(context);
    const first = outputJson(await apply(context, "A", firstPreview.planDigest));
    if (process.platform === "win32") assert.equal(first.links.opencodeEntry, "hardlink");
    await assertLink(p.opencodeEntry, p.opencodeCanonical);
    assert.equal((await stat(p.canonical)).nlink, 1);

    await writeFile(context.templatePath, "# Ryuuji version two\n", "utf8");
    await scanAndScaffold(context);
    const secondPreview = await preview(context);
    const second = outputJson(await apply(context, "A", secondPreview.planDigest));
    assert.equal(await readFile(p.canonical, "utf8"), "# Ryuuji version two\n");
    assert.equal(await readFile(p.opencodeEntry, "utf8"), "# Ryuuji version two\n");
    await assertLink(p.opencodeEntry, p.opencodeCanonical);
    assert.equal((await stat(p.canonical)).nlink, 1);
    if (process.platform === "win32") assert.equal(second.links.opencodeEntry, "hardlink");
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("wrong confirmation and post-scan edits are rejected without writes", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    await scanAndScaffold(context);
    const dryRun = await preview(context);
    const denied = await apply(context, "A", "incorrect", 1);
    assert.match(denied.stderr, /Confirmation digest does not match/);
    assert.equal(await readFile(context.paths.canonical, "utf8"), "# Current\n\nRemove this.\n");

    await writeFile(context.paths.canonical, "# Edited after scan\n", "utf8");
    const conflict = await preview(context, 1);
    assert.equal(conflict.valid, false);
    const conflictReport = await previewReport(conflict);
    assert.match(conflictReport, /conflict/);
    assert.match(conflictReport, /CLAUDE\.md/);
    const deniedApply = await apply(context, "A", conflict.planDigest, 1);
    assert.match(deniedApply.stderr, /Files changed after scanning/);
    assert.equal(await readFile(context.paths.canonical, "utf8"), "# Edited after scan\n");
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("invalid UTF-8 stops scaffold instead of replacing prompt bytes", async () => {
  const context = await fixture();
  try {
    await mkdir(dirname(context.paths.canonical), { recursive: true });
    await writeFile(context.paths.canonical, Buffer.from([0xff, 0xfe, 0xfd]));
    await scan(context);
    const denied = invoke([
      "scaffold",
      "--inventory",
      context.inventory,
      "--output",
      context.plan,
    ], 1);
    assert.match(denied.stderr, /not valid UTF-8/);
    assert.deepEqual(await readFile(context.paths.canonical), Buffer.from([0xff, 0xfe, 0xfd]));
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("live locks and decoy backups fail closed while stale locks are reclaimed", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    await scanAndScaffold(context);
    const dryRun = await preview(context);
    const original = await captureManaged(context);
    await mkdir(context.paths.stateRoot, { recursive: true });
    await writeFile(context.paths.lock, `${process.pid}\n`, "utf8");
    const locked = await apply(context, "A", dryRun.planDigest, 1);
    assert.match(locked.stderr, /lock held by pid/);
    assert.deepEqual(await captureManaged(context), original);

    await writeFile(context.paths.lock, "99999999\n", "utf8");
    const backupRoot = join(
      context.paths.stateRoot,
      "backups",
      `${dryRun.planDigest}-A`,
    );
    await writeJson(join(backupRoot, "manifest.json"), { decoy: true });
    const decoy = await apply(context, "A", dryRun.planDigest, 1);
    assert.match(decoy.stderr, /Existing backup does not match/);
    assert.deepEqual(await captureManaged(context), original);
    assert.deepEqual(await readJson(join(backupRoot, "manifest.json")), { decoy: true });

    await rm(backupRoot, { recursive: true, force: true });
    await writeFile(context.paths.lock, "", "utf8");
    const malformed = await apply(context, "A", dryRun.planDigest, 1);
    assert.match(malformed.stderr, /lock held by pid unknown/);
    assert.deepEqual(await captureManaged(context), original);
    const old = new Date(Date.now() - 120_000);
    await utimes(context.paths.lock, old, old);
    const applied = outputJson(await apply(context, "A", dryRun.planDigest));
    assert.ok(applied.changed > 0);
    await assertAbsent(context.paths.lock);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("a mid-apply failure rolls back every target and the same backup supports retry", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    const alternate = join(context.temporaryRoot, "alternate.md");
    await writeFile(alternate, "# Alternate\n", "utf8");
    await rm(context.paths.codexBase);
    try {
      await symlink(alternate, context.paths.codexBase, "file");
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
      console.log("info - symlink rollback fixture unavailable on this host; covering regular-file rollback instead");
      await writeFile(context.paths.codexBase, "# Current\n\nRemove this.\n", "utf8");
    }
    const plan = await scanAndScaffold(context);
    for (const id of Object.keys(plan.branches.C)) plan.branches.C[id] = `# ${id} increment\n`;
    await writeJson(context.plan, plan);
    const dryRun = await preview(context);
    const original = await captureManaged(context);

    const failed = await apply(context, "C", dryRun.planDigest, 1, {
      AGENT_PROMPT_SYNC_TEST_MODE: "1",
      AGENT_PROMPT_SYNC_TEST_FAIL_ROLE: "opencodeConfig",
    });
    assert.match(failed.stderr, /rollback completed/);
    assert.deepEqual(await captureManaged(context), original);

    const applied = outputJson(await apply(context, "C", dryRun.planDigest));
    const manifest = await readJson(join(applied.backup, "manifest.json"));
    assert.equal(manifest.status, "completed");
    assert.equal(await readFile(context.paths.opencodeDelta, "utf8"), "# opencode increment\n");
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("a prepared backup resumes a partially applied transaction after a crash", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    const plan = await scanAndScaffold(context);
    for (const id of Object.keys(plan.branches.C)) plan.branches.C[id] = `# ${id} increment\n`;
    await writeJson(context.plan, plan);
    const dryRun = await preview(context);
    const crashed = await apply(context, "C", dryRun.planDigest, 1, {
      AGENT_PROMPT_SYNC_TEST_MODE: "1",
      AGENT_PROMPT_SYNC_TEST_CRASH_ROLE: "cursorCanonicalEntry",
    });
    assert.match(crashed.stderr, /Simulated crash at cursorCanonicalEntry/);
    const backupRoot = join(context.paths.stateRoot, "backups", `${dryRun.planDigest}-C`);
    const prepared = await readJson(join(backupRoot, "manifest.json"));
    assert.equal(prepared.status, "prepared");
    assert.equal(await readFile(context.paths.codexComposite, "utf8"), compose(context.template, "# codex increment\n"));
    assert.equal((await capture(context.paths.cursorLegacy)).kind, "file");

    const resumed = outputJson(await apply(context, "C", dryRun.planDigest));
    assert.equal(resumed.changed > 0, true);
    assert.equal((await readJson(join(backupRoot, "manifest.json"))).status, "completed");
    await assertLink(context.paths.cursorCanonicalEntry, context.paths.cursorCanonical);
    await assertAbsent(context.paths.cursorLegacy);
    assert.equal(await readFile(context.paths.opencodeDelta, "utf8"), "# opencode increment\n");
    const repeated = outputJson(await apply(context, "C", dryRun.planDigest));
    assert.equal(repeated.changed, 0);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("rollback restores a managed hardlink after its target and a later operation fail", async () => {
  const context = await fixture();
  try {
    const p = context.paths;
    await mkdir(dirname(p.canonical), { recursive: true });
    await mkdir(dirname(p.opencodeEntry), { recursive: true });
    await writeFile(p.canonical, context.template, "utf8");
    await writeFile(p.opencodeEntry, context.template, "utf8");
    await writeJson(p.opencodeConfig, { plugin: ["context-mode"] });
    await scanAndScaffold(context);
    const initialPreview = await preview(context);
    outputJson(await apply(context, "A", initialPreview.planDigest));
    await assertLink(p.opencodeEntry, p.opencodeCanonical);

    await writeFile(context.templatePath, "# Ryuuji version two\n", "utf8");
    const plan = await scanAndScaffold(context);
    plan.branches.C.opencode = "# OpenCode increment\n";
    await writeJson(context.plan, plan);
    const dryRun = await preview(context);
    const original = await captureManaged(context);
    const failed = await apply(context, "C", dryRun.planDigest, 1, {
      AGENT_PROMPT_SYNC_TEST_MODE: "1",
      AGENT_PROMPT_SYNC_TEST_FAIL_ROLE: "opencodeConfig",
    });
    assert.match(failed.stderr, /rollback completed/);
    assert.deepEqual(await captureManaged(context), original);
    assert.equal(await readFile(p.opencodeEntry, "utf8"), context.template);
    await assertLink(p.opencodeEntry, p.opencodeCanonical);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("OpenCode jsonc wins over json and keeps json untouched", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    const jsonc = `{
  // personal
  "mcp": { "existing": true },
  "instructions": ["docs/existing.md"],
}
`;
    await writeFile(context.paths.opencodeConfigJsonc, jsonc, "utf8");
    await writeJson(context.paths.opencodeConfig, { instructions: ["ignored.md"] });
    const jsonBefore = await readFile(context.paths.opencodeConfig, "utf8");
    const plan = await scanAndScaffold(context);
    plan.branches.C.opencode = "# OpenCode increment\n";
    await writeJson(context.plan, plan);
    const dryRun = await preview(context);
    outputJson(await apply(context, "C", dryRun.planDigest));
    const updated = await readFile(context.paths.opencodeConfigJsonc, "utf8");
    const parsed = JSON.parse(updated);
    assert.deepEqual(parsed.mcp, { existing: true });
    assert.deepEqual(parsed.instructions, ["docs/existing.md", context.paths.opencodeDelta]);
    assert.equal(await readFile(context.paths.opencodeConfig, "utf8"), jsonBefore);
    assert.equal(await readFile(context.paths.opencodeDelta, "utf8"), "# OpenCode increment\n");
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("invalid OpenCode jsonc stops preview without writes", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    await writeFile(context.paths.opencodeConfigJsonc, "/* broken */ {", "utf8");
    const original = await captureManaged(context);
    await scanAndScaffold(context);
    const denied = invoke(["preview", "--plan", context.plan], 1);
    assert.match(denied.stderr, /not valid JSON or JSONC/);
    assert.deepEqual(await captureManaged(context), original);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("Claude unmanaged rules stay in place through apply A", async () => {
  const context = await fixture();
  try {
    const extra = join(context.home, ".claude", "rules", "personal.md");
    await mkdir(dirname(extra), { recursive: true });
    await writeFile(extra, "# Keep me\n", "utf8");
    const result = await scan(context);
    assert.deepEqual(result.agents, ["claude-code"]);
    const inventory = await readJson(context.inventory);
    assert.equal(inventory.agents[0].preserved[0].path, extra);
    await completeScaffold(context);
    const dryRun = await preview(context);
    outputJson(await apply(context, "A", dryRun.planDigest));
    assert.equal(await readFile(extra, "utf8"), "# Keep me\n");
    assert.equal(await readFile(context.paths.canonical, "utf8"), context.template);
    await assertAbsent(context.paths.claudeDelta);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("excludedAgents skip that agent and survive a later scan", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    await scan(context);
    const inventory = await readJson(context.inventory);
    const cursorLegacy = await readFile(context.paths.cursorLegacy, "utf8");
    inventory.agents = inventory.agents.filter((agent) => agent.id !== "cursor");
    inventory.excludedAgents = [{ id: "cursor", reason: "unused residual" }];
    await writeJson(context.inventory, inventory);
    const plan = await completeScaffold(context);
    assert.equal("cursor" in plan.branches.A, false);
    const dryRun = await preview(context);
    assert.match(await previewReport(dryRun), /cursor: unused residual/);
    outputJson(await apply(context, "A", dryRun.planDigest));
    assert.equal(await readFile(context.paths.cursorLegacy, "utf8"), cursorLegacy);
    await assertAbsent(context.paths.cursorCanonicalEntry);

    const rescanned = await scan(context);
    assert.deepEqual(rescanned.excludedAgents, ["cursor"]);
    assert.equal(rescanned.agents.includes("cursor"), false);
    const again = await readJson(context.inventory);
    assert.deepEqual(again.excludedAgents, [{ id: "cursor", reason: "unused residual" }]);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("excluding claude-code leaves the canonical file unchanged", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    const original = await readFile(context.paths.canonical, "utf8");
    await scan(context);
    const inventory = await readJson(context.inventory);
    inventory.agents = inventory.agents.filter((agent) => agent.id !== "claude-code");
    inventory.excludedAgents = [{ id: "claude-code", reason: "leave Claude files" }];
    await writeJson(context.inventory, inventory);
    await completeScaffold(context);
    const dryRun = await preview(context);
    outputJson(await apply(context, "A", dryRun.planDigest));
    assert.equal(await readFile(context.paths.canonical, "utf8"), original);
    await assertLink(context.paths.cursorCanonicalEntry, context.paths.cursorCanonical);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("cursor-only apply does not create the Claude canonical file", async () => {
  const context = await fixture();
  try {
    await mkdir(dirname(context.paths.cursorLegacy), { recursive: true });
    await writeFile(context.paths.cursorLegacy, "# Cursor only\n", "utf8");
    await scanAndScaffold(context);
    const dryRun = await preview(context);
    outputJson(await apply(context, "A", dryRun.planDigest));
    await assertAbsent(context.paths.canonical);
    await assertLink(context.paths.cursorCanonicalEntry, context.paths.cursorCanonical);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("local Cursor account User Rules block apply until cleared and scanned again", async () => {
  const context = await fixture();
  try {
    await mkdir(dirname(context.paths.cursorLegacy), { recursive: true });
    await writeFile(context.paths.cursorLegacy, "# Cursor\n", "utf8");
    await writeCursorAccountRules(context.paths.cursorAccountDb, "# Account rules\n");
    const scanned = await scan(context);
    assert.equal(scanned.warnings[0]?.code, "cursor-account-user-rules-block");
    await completeScaffold(context);
    const blockedPreview = await preview(context, 1);
    assert.equal(blockedPreview.valid, false);
    assert.match(await previewReport(blockedPreview), /Apply is refused/);
    const blockedApply = await apply(context, "A", blockedPreview.planDigest, 1);
    assert.match(blockedApply.stderr, /still have local content/);
    await assertAbsent(context.paths.cursorCanonicalEntry);

    await writeCursorAccountRules(context.paths.cursorAccountDb, "  ");
    await scanAndScaffold(context);
    const dryRun = await preview(context);
    assert.equal(dryRun.valid, true);
    outputJson(await apply(context, "A", dryRun.planDigest));
    await assertLink(context.paths.cursorCanonicalEntry, context.paths.cursorCanonical);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

test("listing an agent as both detected and excluded is rejected", async () => {
  const context = await fixture();
  try {
    await setupAll(context);
    await scan(context);
    const inventory = await readJson(context.inventory);
    inventory.excludedAgents = [{ id: "cursor", reason: "unused residual" }];
    await writeJson(context.inventory, inventory);
    const denied = invoke([
      "scaffold",
      "--inventory",
      context.inventory,
      "--output",
      context.plan,
    ], 1);
    assert.match(denied.stderr, /both detected and excluded/);
  } finally {
    await rm(context.temporaryRoot, { recursive: true, force: true });
  }
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}\n${error.stack ?? error}`);
  }
}
if (failures) process.exitCode = 1;
else console.log(`${tests.length} tests passed`);
