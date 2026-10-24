import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  link as createHardlink,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink as createSymlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const BRANCHES = ["A", "B", "C"];
const CURSOR_FRONTMATTER = "---\nalwaysApply: true\n---\n\n";
const here = dirname(fileURLToPath(import.meta.url));
const defaultTemplate = resolve(here, "../references/ryuuji-user-prompt.md");
const agents = [
  { id: "claude-code", command: "claude" },
  { id: "codex", command: "codex" },
  { id: "cursor", command: "cursor" },
  { id: "opencode", command: "opencode" },
];
const unsupportedCommands = [
  "gemini",
  "qwen",
  "copilot",
  "kimi",
  "cline",
  "windsurf",
  "continue",
  "amp",
  "openclaw",
  "antigravity",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-commands") {
      options.noCommands = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[key] = value;
      index += 1;
      continue;
    }
    options._.push(arg);
  }
  return options;
}

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function managedPaths(root) {
  const stateRoot = resolve(root, ".agent-prompt-sync");
  return {
    stateRoot,
    lock: resolve(stateRoot, "lock"),
    canonical: resolve(root, ".claude/CLAUDE.md"),
    claudeDelta: resolve(root, ".claude/rules/agent-prompt-sync.md"),
    codexComposite: resolve(stateRoot, "generated/codex/AGENTS.md"),
    codexBase: resolve(root, ".codex/AGENTS.md"),
    codexOverride: resolve(root, ".codex/AGENTS.override.md"),
    cursorCanonical: resolve(stateRoot, "generated/cursor/ryuuji.mdc"),
    cursorCanonicalEntry: resolve(root, ".cursor/rules/ryuuji.mdc"),
    cursorDelta: resolve(root, ".cursor/rules/agent-prompt-sync.mdc"),
    cursorLegacy: resolve(root, ".cursor/AGENTS.md"),
    opencodeCanonical: resolve(stateRoot, "generated/opencode/AGENTS.md"),
    opencodeEntry: resolve(root, ".config/opencode/AGENTS.md"),
    opencodeDelta: resolve(root, ".config/opencode/rules/agent-prompt-sync.md"),
    opencodeConfig: resolve(root, ".config/opencode/opencode.json"),
    opencodeConfigJsonc: resolve(root, ".config/opencode/opencode.jsonc"),
  };
}

const pathRoles = [
  "canonical",
  "claudeDelta",
  "codexComposite",
  "codexBase",
  "codexOverride",
  "cursorCanonical",
  "cursorCanonicalEntry",
  "cursorDelta",
  "cursorLegacy",
  "opencodeCanonical",
  "opencodeEntry",
  "opencodeDelta",
  "opencodeConfig",
  "opencodeConfigJsonc",
];
const inventoryContentRoles = new Set([
  "canonical",
  "claudeDelta",
  "codexBase",
  "codexOverride",
  "cursorLegacy",
  "cursorCanonicalEntry",
  "cursorDelta",
  "opencodeEntry",
  "opencodeDelta",
  "opencodeConfig",
  "opencodeConfigJsonc",
]);

function fileId(stat) {
  if (!stat || !Number.isFinite(stat.dev) || !Number.isFinite(stat.ino) || stat.ino === 0) {
    return null;
  }
  return `${stat.dev}:${stat.ino}`;
}

function decodeUtf8(bytes, path) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes.toString("utf8");
  } catch {
    throw new Error(`Prompt content is not valid UTF-8: ${path}`);
  }
}

async function snapshot(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, kind: "absent", path, sha256: null, content: null };
    }
    throw error;
  }

  const base = {
    exists: true,
    path,
    sha256: null,
    content: null,
    textValid: null,
    linkTarget: null,
    resolvedLinkTarget: null,
    fileId: fileId(metadata),
  };
  if (metadata.isSymbolicLink()) {
    const linkTarget = await readlink(path);
    let targetMetadata;
    try {
      targetMetadata = await stat(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return { ...base, kind: "symlink", linkTarget, resolvedLinkTarget: resolve(dirname(path), linkTarget) };
    }
    const result = {
      ...base,
      kind: "symlink",
      linkTarget,
      resolvedLinkTarget: resolve(dirname(path), linkTarget),
      fileId: fileId(targetMetadata),
    };
    if (!targetMetadata.isFile()) return result;
    const bytes = await readFile(path);
    result.sha256 = sha256(bytes);
    result.size = bytes.length;
    try {
      result.content = decodeUtf8(bytes, path);
      result.textValid = true;
    } catch {
      result.textValid = false;
    }
    return result;
  }
  if (!metadata.isFile()) {
    return { ...base, kind: metadata.isDirectory() ? "directory" : "other" };
  }
  const bytes = await readFile(path);
  const result = {
    ...base,
    kind: "file",
    sha256: sha256(bytes),
    size: bytes.length,
  };
  try {
    result.content = decodeUtf8(bytes, path);
    result.textValid = true;
  } catch {
    result.textValid = false;
  }
  return result;
}

function inventoryState(state, keepContent) {
  if (keepContent || !state?.exists || state.content == null) return state;
  return { ...state, content: null };
}

function fingerprint(state) {
  if (!state?.exists) return { exists: false, kind: "absent" };
  return {
    exists: true,
    kind: state.kind,
    sha256: state.sha256 ?? null,
    linkTarget: state.linkTarget ?? null,
    resolvedLinkTarget: state.resolvedLinkTarget ?? null,
  };
}

function sameFingerprint(left, right) {
  return JSON.stringify(fingerprint(left)) === JSON.stringify(fingerprint(right));
}

function sameFile(left, right) {
  return Boolean(
    left?.exists && right?.exists &&
    left.kind === "file" && right.kind === "file" &&
    left.fileId && right.fileId && left.fileId === right.fileId
  );
}

async function readJson(path) {
  const bytes = await readFile(path);
  const raw = decodeUtf8(bytes, path);
  return { value: JSON.parse(raw), raw, sha256: sha256(bytes) };
}

function temporaryPath(path) {
  return resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeJson(path, value) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeAtomic(path, raw, "utf8");
  return sha256(Buffer.from(raw, "utf8"));
}

function commandExists(command) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function agentDefinition(id) {
  const definition = agents.find((agent) => agent.id === id);
  if (!definition) throw new Error(`Unsupported agent in plan: ${id}`);
  return definition;
}

function validateExcludedAgents(list) {
  if (!Array.isArray(list)) throw new Error("excludedAgents must be an array");
  const seen = new Set();
  return list.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("excludedAgents entries must be objects");
    }
    if (!agents.some((agent) => agent.id === item.id)) {
      throw new Error(`Unknown excluded agent: ${item.id}`);
    }
    if (seen.has(item.id)) throw new Error(`Duplicate excluded agent: ${item.id}`);
    if (typeof item.reason !== "string" || !item.reason.trim()) {
      throw new Error(`excludedAgents reason is required for ${item.id}`);
    }
    seen.add(item.id);
    return { id: item.id, reason: item.reason.trim() };
  });
}

function assertExcludedNotDetected(excludedAgents, detected) {
  const detectedIds = new Set(detected.map((agent) => agent.id));
  for (const item of excludedAgents) {
    if (detectedIds.has(item.id)) {
      throw new Error(`${item.id} is listed as both detected and excluded`);
    }
  }
}

function openCodeConfigRole(states) {
  return states.opencodeConfigJsonc?.exists ? "opencodeConfigJsonc" : "opencodeConfig";
}

function stripJsoncComments(text) {
  let out = "";
  let inString = false;
  let escape = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      index += 1;
      continue;
    }
    if (char === "\"") inString = true;
    out += char;
  }
  return out;
}

function removeTrailingCommas(text) {
  let out = "";
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let look = index + 1;
      while (look < text.length && /\s/.test(text[look])) look += 1;
      if (look < text.length && (text[look] === "}" || text[look] === "]")) continue;
    }
    out += char;
  }
  return out;
}

function parseJsonDocument(raw, path) {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(removeTrailingCommas(stripJsoncComments(raw)));
    } catch {
      throw new Error(`OpenCode config is not valid JSON or JSONC: ${path}`);
    }
  }
}

function allowTestHooks(root) {
  return process.env.AGENT_PROMPT_SYNC_TEST_MODE === "1" && resolve(root) !== resolve(homedir());
}

async function loadExcludedAgentsFromInventory(path) {
  try {
    const loaded = await readJson(path);
    return validateExcludedAgents(loaded.value?.excludedAgents ?? []);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    if (error instanceof Error && /excludedAgents|Unknown excluded agent|Duplicate excluded agent/.test(error.message)) {
      throw error;
    }
    return [];
  }
}

async function scanUnmanagedRules(rulesRoot, extension, managed) {
  const collected = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(path);
      } else if (entry.name.endsWith(extension) && !managed.has(path)) {
        collected.push(await snapshot(path));
      }
    }
  }
  await visit(rulesRoot);
  return collected;
}

async function scanCursorUnmanagedRules(paths) {
  return scanUnmanagedRules(
    resolve(paths.cursorCanonicalEntry, ".."),
    ".mdc",
    new Set([paths.cursorCanonicalEntry, paths.cursorDelta]),
  );
}

async function scanClaudeUnmanagedRules(paths) {
  return scanUnmanagedRules(
    resolve(paths.claudeDelta, ".."),
    ".md",
    new Set([paths.claudeDelta]),
  );
}

function analysisRoles(id) {
  return {
    "claude-code": ["canonical", "claudeDelta"],
    codex: ["codexBase", "codexOverride"],
    cursor: ["cursorLegacy", "cursorCanonicalEntry", "cursorDelta"],
    opencode: ["opencodeEntry", "opencodeDelta"],
  }[id];
}

async function scan(options) {
  const output = resolve(required(options.output, "--output"));
  const root = resolve(options.root ?? homedir());
  const templatePath = resolve(options.template ?? defaultTemplate);
  const template = await snapshot(templatePath);
  if (!template.exists || template.textValid !== true) {
    throw new Error(`Ryuuji template must be a valid UTF-8 file: ${templatePath}`);
  }
  const detectCommands = !options.root && !options.noCommands;
  const excludedAgents = await loadExcludedAgentsFromInventory(output);
  const excludedIds = new Set(excludedAgents.map((item) => item.id));
  const paths = managedPaths(root);
  const states = {};
  for (const role of pathRoles) {
    states[role] = inventoryState(await snapshot(paths[role]), inventoryContentRoles.has(role));
  }
  const cursorUnmanagedRules = await scanCursorUnmanagedRules(paths);
  const claudeUnmanagedRules = await scanClaudeUnmanagedRules(paths);
  const detected = [];

  for (const definition of agents) {
    if (excludedIds.has(definition.id)) continue;
    const byCommand = detectCommands && commandExists(definition.command);
    let byPrompt = false;
    if (definition.id === "claude-code") {
      byPrompt = states.canonical.exists || states.claudeDelta.exists || claudeUnmanagedRules.length > 0;
    }
    if (definition.id === "codex") byPrompt = states.codexBase.exists || states.codexOverride.exists;
    if (definition.id === "cursor") {
      byPrompt = states.cursorLegacy.exists || states.cursorCanonicalEntry.exists ||
        states.cursorDelta.exists || cursorUnmanagedRules.length > 0;
    }
    if (definition.id === "opencode") byPrompt = states.opencodeEntry.exists;
    if (!byPrompt && !byCommand) continue;
    const roles = analysisRoles(definition.id);
    let preserved = [];
    if (definition.id === "cursor") {
      preserved = [...cursorUnmanagedRules];
    } else if (definition.id === "claude-code") {
      preserved = claudeUnmanagedRules;
    }
    detected.push({
      id: definition.id,
      command: definition.command,
      detectedBy: [byPrompt ? "prompt-file" : null, byCommand ? "command" : null].filter(Boolean),
      sources: roles.filter((role) => states[role].exists),
      preserved,
    });
  }

  const unsupportedAgents = detectCommands
    ? unsupportedCommands.filter(commandExists).map((command) => ({
        command,
        reason: "No verified user-level prompt mapping; leave unchanged",
      }))
    : [];
  const inventory = {
    schema: "agent-prompt-sync-inventory/3",
    root,
    template: {
      path: templatePath,
      sha256: template.sha256,
      content: template.content,
    },
    states,
    agents: detected,
    excludedAgents,
    unsupportedAgents,
  };
  const inventorySha256 = await writeJson(output, inventory);
  console.log(JSON.stringify({
    schema: "agent-prompt-sync-scan-result/3",
    inventory: output,
    inventorySha256,
    agents: detected.map((agent) => agent.id),
    excludedAgents: excludedAgents.map((item) => item.id),
    unsupportedAgents,
  }, null, 2));
}

async function loadInventory(path, expectedSha256) {
  const loaded = await readJson(path);
  if (expectedSha256 && loaded.sha256 !== expectedSha256) {
    throw new Error("Inventory changed after plan creation; scan and plan again");
  }
  const inventory = loaded.value;
  if (inventory.schema !== "agent-prompt-sync-inventory/3") {
    throw new Error("Invalid inventory schema");
  }
  if (!isAbsolute(inventory.root)) throw new Error("Inventory root must be absolute");
  if (!inventory.states || typeof inventory.states !== "object") {
    throw new Error("Inventory is missing managed path states");
  }
  if (!Array.isArray(inventory.agents)) throw new Error("Inventory agents must be an array");
  inventory.excludedAgents = validateExcludedAgents(inventory.excludedAgents ?? []);
  assertExcludedNotDetected(inventory.excludedAgents, inventory.agents);
  return inventory;
}

async function scaffold(options) {
  const inventoryPath = resolve(required(options.inventory, "--inventory"));
  const output = resolve(required(options.output, "--output"));
  const loaded = await readJson(inventoryPath);
  const inventory = await loadInventory(inventoryPath);
  if (inventory.agents.length === 0) throw new Error("No supported agents detected");
  for (const agent of inventory.agents) {
    agentDefinition(agent.id);
    for (const role of agent.sources) {
      if (inventory.states[role]?.textValid === false) {
        throw new Error(`Existing prompt is not valid UTF-8: ${inventory.states[role].path}`);
      }
    }
    for (const preserved of agent.preserved ?? []) {
      if (preserved.textValid === false) {
        throw new Error(`Existing unmanaged rule is not valid UTF-8: ${preserved.path}`);
      }
    }
  }
  const increments = () => Object.fromEntries(inventory.agents.map((agent) => [agent.id, ""]));
  const plan = {
    schema: "agent-prompt-sync-plan/3",
    root: inventory.root,
    inventory: { path: inventoryPath, sha256: loaded.sha256 },
    excludedAgents: inventory.excludedAgents,
    recommendation: "A",
    analysis: inventory.agents.map((agent) => ({
      agent: agent.id,
      keep: [],
      drop: [],
      rationale: agent.sources.length === 0 && (agent.preserved ?? []).length === 0
        ? "No existing additional rules; the Ryuuji template is sufficient"
        : "TODO: classify existing rules before preview",
    })),
    branches: { A: increments(), B: increments(), C: increments() },
  };
  await writeJson(output, plan);
  console.log(JSON.stringify({
    plan: output,
    agents: inventory.agents.map((agent) => agent.id),
    excludedAgents: inventory.excludedAgents.map((item) => item.id),
  }, null, 2));
}

function validateAnalysis(plan, agentIds, planPath) {
  const where = `plan ${planPath}`;
  if (!["A", "C"].includes(plan.recommendation)) {
    throw new Error(
      `${where}: recommendation is "${plan.recommendation}". Set analysis[i].recommendation to "A" or "C". `
      + "Branch B is shown but never recommended.",
    );
  }
  if (!Array.isArray(plan.analysis)) throw new Error(`${where}: analysis must be an array, one entry per detected agent`);
  const analyzed = new Set();
  plan.analysis.forEach((item, index) => {
    const at = `analysis[${index}]`;
    if (!agentIds.includes(item.agent)) {
      throw new Error(
        `${where}: ${at}.agent is "${item.agent}". Detected agents: ${agentIds.join(", ")}.`,
      );
    }
    if (analyzed.has(item.agent)) throw new Error(`${where}: analysis lists ${item.agent} twice`);
    if (!Array.isArray(item.keep) || !Array.isArray(item.drop)) {
      throw new Error(
        `${where}: ${at} (agent ${item.agent}) needs both keep and drop as arrays of rule sentences. Use [] when empty.`,
      );
    }
    if (typeof item.rationale !== "string" || !item.rationale.trim() || item.rationale.startsWith("TODO")) {
      throw new Error(
        `${where}: ${at}.rationale (agent ${item.agent}) is still empty or starts with TODO. `
        + `Write one sentence explaining the classification. See references/plan-example.md for a filled example.`,
      );
    }
    analyzed.add(item.agent);
  });
  for (const id of agentIds) {
    if (!analyzed.has(id)) throw new Error(`${where}: analysis has no entry for ${id}. Add { "agent": "${id}", "keep": [], "drop": [], "rationale": "..." }`);
  }
}

function ruleLines(increment) {
  if (!increment) return [];
  return increment
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line !== "---");
}

function normalizeRule(text) {
  return String(text)
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/[，。；：、！？,.;:!?「」『』"'\s]/g, "")
    .toLowerCase();
}

function sameRule(left, right) {
  const a = normalizeRule(left);
  const b = normalizeRule(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function validateAnalysisAgainstBranches(plan, agentIds, planPath) {
  for (const id of agentIds) {
    const item = plan.analysis.find((entry) => entry.agent === id);
    const savedByC = ruleLines(plan.branches.C[id]);
    const savedByB = ruleLines(plan.branches.B[id]);
    const kept = item.keep;
    const dropped = item.drop;

    for (const rule of kept) {
      if (!savedByB.some((line) => sameRule(line, rule))) {
        throw new Error(
          `plan ${planPath}: analysis keep lists "${rule}" for ${id}, but branch B does not write it. `
          + "Anything kept must appear in the branch increments. See references/plan-example.md.",
        );
      }
      if (dropped.some((rule2) => sameRule(rule2, rule))) {
        throw new Error(
          `plan ${planPath}: ${id} lists "${rule}" in both keep and drop. Keep one side only.`,
        );
      }
    }

    for (const line of savedByC) {
      if (!kept.some((rule) => sameRule(line, rule))) {
        throw new Error(
          `plan ${planPath}: branch C writes "${line}" for ${id}, but analysis keep has no matching sentence. `
          + "Add it to keep or remove it from branch C.",
        );
      }
    }
  }
}

async function loadPlan(path) {
  const loaded = await readJson(path);
  const plan = loaded.value;
  if (plan.schema !== "agent-prompt-sync-plan/3") throw new Error("Invalid plan schema");
  if (!isAbsolute(plan.root)) throw new Error("Plan root must be absolute");
  const inventory = await loadInventory(plan.inventory?.path, plan.inventory?.sha256);
  if (inventory.root !== plan.root) throw new Error("Plan and inventory roots differ");
  if (JSON.stringify(plan.excludedAgents ?? []) !== JSON.stringify(inventory.excludedAgents)) {
    throw new Error("Plan excludedAgents must match the inventory");
  }
  const agentIds = inventory.agents.map((agent) => agent.id).sort();
  validateAnalysis(plan, agentIds, path);

  for (const branch of BRANCHES) {
    const content = plan.branches?.[branch];
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      throw new Error(`Missing branch ${branch}`);
    }
    const ids = Object.keys(content).sort();
    if (ids.length !== agentIds.length || ids.some((id, index) => id !== agentIds[index])) {
      throw new Error(`Branch ${branch} must cover every detected agent exactly once`);
    }
    for (const id of ids) {
      agentDefinition(id);
      if (typeof content[id] !== "string") {
        throw new Error(`Branch ${branch} increment for ${id} must be a string`);
      }
      if (branch === "A" && content[id] !== "") {
        throw new Error("Branch A must use empty increments for every agent");
      }
    }
  }
  for (const id of agentIds) {
    const keptByC = ruleLines(plan.branches.C[id]);
    const keptByB = ruleLines(plan.branches.B[id]);
    const missing = keptByC.filter((line) => !keptByB.some((other) => sameRule(other, line)));
    if (missing.length) {
      throw new Error(
        `plan ${path}: branch B must keep every rule branch C keeps for ${id}. Missing: ${missing.join(" | ")}`,
      );
    }
  }
  validateAnalysisAgainstBranches(plan, agentIds, path);
  return { plan, inventory, planDigest: loaded.sha256 };
}

function compose(canonical, increment) {
  if (!increment) return canonical;
  return `${canonical}${canonical.endsWith("\n") ? "\n" : "\n\n"}${increment}`;
}

function desiredOpenCodeConfig(base, deltaPath, increment) {
  if (!base.exists) {
    if (!increment) return { kind: "absent" };
    return {
      kind: "file",
      content: `${JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        instructions: [deltaPath],
      }, null, 2)}\n`,
    };
  }
  if (base.textValid !== true) throw new Error(`OpenCode config is not valid UTF-8: ${base.path}`);
  const config = parseJsonDocument(base.content, base.path);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`OpenCode config must contain a JSON object: ${base.path}`);
  }
  const original = config.instructions === undefined ? [] : config.instructions;
  if (!Array.isArray(original) || original.some((entry) => typeof entry !== "string")) {
    throw new Error(`OpenCode config instructions must be a string array: ${base.path}`);
  }
  const managed = (entry) => entry === deltaPath || (isAbsolute(entry) && resolve(entry) === deltaPath);
  const retained = original.filter((entry) => !managed(entry));
  const managedCount = original.length - retained.length;
  if (increment && managedCount === 1) return { kind: "check" };
  if (!increment && managedCount === 0) return { kind: "check" };

  const updated = { ...config };
  if (increment) {
    updated.instructions = [...retained, deltaPath];
  } else if (retained.length === 0 && original.length > 0) {
    delete updated.instructions;
  } else {
    updated.instructions = retained;
  }
  if (base.kind !== "file") {
    throw new Error(`Refusing to replace a non-regular OpenCode config: ${base.path}`);
  }
  return { kind: "file", content: `${JSON.stringify(updated, null, 2)}\n` };
}

function buildOperations(plan, inventory, branch, templateContent) {
  const paths = managedPaths(plan.root);
  const operations = [];
  const add = (operation) => operations.push({ agent: null, ...operation });
  const file = (role, agent, content) => add({
    role, agent, path: paths[role], kind: "file", content: Buffer.from(content, "utf8"),
  });
  const absent = (role, agent) => add({ role, agent, path: paths[role], kind: "absent" });
  const link = (role, agent, targetRole) => add({
    role, agent, path: paths[role], kind: "link", targetRole, targetPath: paths[targetRole],
  });
  const check = (role, agent) => add({
    role, agent, path: paths[role], kind: "check", expected: inventory.states[role],
  });
  const deltaFile = (role, agent, increment, wrapper = "") => {
    if (increment) file(role, agent, `${wrapper}${increment}`);
    else absent(role, agent);
  };

  if (inventory.agents.some((agent) => agent.id === "claude-code")) {
    file("canonical", "claude-code", templateContent);
  }
  for (const agent of inventory.agents) {
    const id = agent.id;
    const increment = plan.branches[branch][id];
    if (id === "claude-code") {
      deltaFile("claudeDelta", id, increment);
    } else if (id === "codex") {
      file("codexComposite", id, compose(templateContent, increment));
      const baseExists = inventory.states.codexBase.exists;
      const overrideExists = inventory.states.codexOverride.exists;
      if (baseExists || !overrideExists) link("codexBase", id, "codexComposite");
      else absent("codexBase", id);
      if (overrideExists) link("codexOverride", id, "codexComposite");
      else absent("codexOverride", id);
    } else if (id === "cursor") {
      file("cursorCanonical", id, `${CURSOR_FRONTMATTER}${templateContent}`);
      link("cursorCanonicalEntry", id, "cursorCanonical");
      deltaFile("cursorDelta", id, increment, CURSOR_FRONTMATTER);
      absent("cursorLegacy", id);
    } else if (id === "opencode") {
      file("opencodeCanonical", id, templateContent);
      link("opencodeEntry", id, "opencodeCanonical");
      deltaFile("opencodeDelta", id, increment);
      const configRole = openCodeConfigRole(inventory.states);
      const config = desiredOpenCodeConfig(
        inventory.states[configRole],
        paths.opencodeDelta,
        increment,
      );
      if (config.kind === "file") file(configRole, id, config.content);
      else if (config.kind === "absent") absent(configRole, id);
      else check(configRole, id);
    }
  }
  return operations;
}

function desiredMatches(operation, current, currentStates) {
  if (operation.kind === "check") return sameFingerprint(current, operation.expected);
  if (operation.kind === "absent") return !current.exists;
  if (operation.kind === "file") {
    return current.exists && current.kind === "file" && current.sha256 === sha256(operation.content);
  }
  if (operation.kind === "link") {
    if (current.exists && current.kind === "symlink" &&
        current.resolvedLinkTarget === operation.targetPath) return true;
    return sameFile(current, currentStates[operation.targetRole]);
  }
  throw new Error(`Unknown operation kind: ${operation.kind}`);
}

async function evaluateBranch(plan, inventory, branch) {
  const template = await snapshot(inventory.template.path);
  if (!template.exists || template.textValid !== true || template.sha256 !== inventory.template.sha256) {
    throw new Error("Ryuuji template changed after scanning; scan and plan again");
  }
  const operations = buildOperations(plan, inventory, branch, template.content);
  const paths = managedPaths(plan.root);
  const currentStates = {};
  for (const role of pathRoles) currentStates[role] = await snapshot(paths[role]);

  for (const operation of operations) {
    const current = currentStates[operation.role];
    const base = inventory.states[operation.role];
    if (!base) throw new Error(`Inventory is missing state for ${operation.role}`);
    operation.current = current;
    operation.base = base;
    operation.currentSha256 = current.sha256 ?? null;
    operation.desiredSha256 = operation.kind === "file" ? sha256(operation.content) : null;
    if (desiredMatches(operation, current, currentStates)) {
      operation.action = "unchanged";
    } else if (operation.kind === "check" || !sameFingerprint(current, base)) {
      operation.action = "conflict";
    } else if (operation.kind === "absent") {
      operation.action = "delete";
    } else {
      operation.action = current.exists ? "update" : "create";
    }
  }

  const byRole = new Map(operations.map((operation) => [operation.role, operation]));
  for (const operation of operations) {
    if (operation.kind !== "link" || operation.action !== "unchanged") continue;
    const targetOperation = byRole.get(operation.targetRole);
    if (!["create", "update"].includes(targetOperation?.action)) continue;
    if (sameFile(operation.current, currentStates[operation.targetRole])) {
      operation.action = "update";
      operation.reason = "Refresh hardlink after replacing its target";
    }
  }
  return operations;
}

function publicOperation(operation) {
  return {
    role: operation.role,
    agent: operation.agent,
    action: operation.action,
    path: operation.path,
    kind: operation.kind,
    currentKind: operation.current?.kind ?? null,
    currentSha256: operation.currentSha256 ?? null,
    desiredSha256: operation.desiredSha256 ?? null,
    targetPath: operation.targetPath ?? null,
    bytes: operation.content?.length ?? 0,
    reason: operation.reason ?? null,
  };
}

function currentText(operation) {
  if (!operation.current?.exists) return null;
  if (operation.current.textValid === true) return operation.current.content;
  if (operation.current.kind === "symlink") return `symlink → ${operation.current.linkTarget}`;
  return `(${operation.current.kind}, ${operation.current.size ?? 0} bytes)`;
}

function desiredText(operation) {
  if (operation.kind === "file") return operation.content.toString("utf8");
  if (operation.kind === "absent") return null;
  if (operation.kind === "link") return `link → ${operation.targetPath}`;
  return null;
}

function briefDiff(oldText, newText, maxLines) {
  if (oldText === newText) return "(content unchanged)";
  const oldLines = oldText == null ? [] : String(oldText).split("\n");
  const newLines = newText == null ? [] : String(newText).split("\n");
  if (oldLines.length * newLines.length > 250_000) {
    return `(too large for line diff: ${oldLines.length} → ${newLines.length} lines)`;
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => new Int32Array(cols));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let equalRun = 0;
  const flushEqual = () => {
    if (equalRun > 0) {
      out.push(`@@ unchanged ${equalRun} line${equalRun === 1 ? "" : "s"} @@`);
      equalRun = 0;
    }
  };
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      equalRun += 1;
      i += 1;
      j += 1;
      continue;
    }
    flushEqual();
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${oldLines[i]}`);
      i += 1;
    } else {
      out.push(`+${newLines[j]}`);
      j += 1;
    }
    if (out.length >= maxLines) {
      out.push("... (truncated)");
      return out.join("\n");
    }
  }
  flushEqual();
  while (i < oldLines.length) {
    out.push(`-${oldLines[i]}`);
    i += 1;
    if (out.length >= maxLines) {
      out.push("... (truncated)");
      return out.join("\n");
    }
  }
  while (j < newLines.length) {
    out.push(`+${newLines[j]}`);
    j += 1;
    if (out.length >= maxLines) {
      out.push("... (truncated)");
      return out.join("\n");
    }
  }
  return out.join("\n") || "(content unchanged)";
}

function changedOperations(operations) {
  return operations.filter((operation) => operation.action !== "unchanged");
}

function shortenPath(path, root) {
  const base = resolve(root);
  const full = resolve(path);
  const slash = (value) => value.split(sep).join("/");
  if (full === base) return "~";
  if (full.startsWith(base + sep)) return `~${slash(full.slice(base.length))}`;
  return slash(path);
}

function derivedLabel(operation, plan, branch, templateContent) {
  if (operation.kind !== "file") return null;
  const text = operation.content.toString("utf8");
  if (text === templateContent) return "正本原文";
  if (text === `${CURSOR_FRONTMATTER}${templateContent}`) return "正本原文加 alwaysApply 头";
  const increment = plan.branches[branch][operation.agent];
  if (increment && text === compose(templateContent, increment)) return "正本原文加本分支增量";
  return null;
}

function renderOperation(operation, plan, branch, templateContent, root) {
  const path = shortenPath(operation.path, root);
  if (operation.kind === "link") {
    return `  - ${operation.action} \`${path}\` (link → \`${shortenPath(operation.targetPath, root)}\`)${operation.reason ? ` — ${operation.reason}` : ""}`;
  }
  if (operation.action === "conflict") {
    return `  - conflict \`${path}\` — 扫描后该文件已变，需要重新 scan`;
  }
  if (operation.kind === "check") return `  - ${operation.action} \`${path}\` (保持原配置)`;
  if (operation.kind === "absent") return `  - ${operation.action} \`${path}\` (删除)`;
  const label = derivedLabel(operation, plan, branch, templateContent);
  if (label) return `  - ${operation.action} \`${path}\` — ${label}`;
  const diff = briefDiff(currentText(operation), desiredText(operation), 40);
  return `  - ${operation.action} \`${path}\`

\`\`\`diff
${diff}
\`\`\``;
}

function renderList(label, items) {
  if (!items.length) return [`  - ${label}：无`];
  return [`  - ${label}：`, ...items.map((item) => `    - ${item}`)];
}

function renderReport(plan, inventory, branchOperations, planDigest, valid) {
  const templateContent = inventory.template.content;
  const root = plan.root;
  const lines = [
    "# agent-prompt-sync dry-run",
    "",
    `推荐分支：${plan.recommendation}`,
    `planDigest：${planDigest}`,
    `valid：${valid}`,
    "",
  ];
  if (inventory.excludedAgents.length) {
    lines.push("## 已排除");
    for (const item of inventory.excludedAgents) lines.push(`- ${item.id}：${item.reason}`);
    lines.push("");
  }
  lines.push("## 分析");
  for (const item of plan.analysis) {
    lines.push(`- ${item.agent}`);
    lines.push(`  - 理由：${item.rationale}`);
    lines.push(...renderList("保留", item.keep));
    lines.push(...renderList("丢弃", item.drop));
  }
  lines.push("");

  const canonicalOperation = branchOperations.A.find((operation) => operation.role === "canonical");
  if (canonicalOperation && canonicalOperation.action !== "unchanged") {
    lines.push(`## 正本 \`${shortenPath(canonicalOperation.path, root)}\`（三版相同）`);
    lines.push("");
    lines.push("```diff");
    lines.push(briefDiff(currentText(canonicalOperation), desiredText(canonicalOperation), 60));
    lines.push("```");
    lines.push("");
  }

  const bEqualsC = inventory.agents.every((agent) => plan.branches.B[agent.id] === plan.branches.C[agent.id]);
  if (bEqualsC && inventory.agents.some((agent) => plan.branches.C[agent.id])) {
    lines.push("## 注意");
    lines.push("");
    lines.push("B 和 C 的增量完全相同，实际只有两个选项。把 B 改成更保守的版本，或直接把 `recommendation` 设为 C 并说明二者等价。");
    lines.push("");
  }

  for (const branch of BRANCHES) {
    const operations = branchOperations[branch];
    const changed = changedOperations(operations);
    const state = operations.every((operation) => operation.action !== "conflict") ? "valid" : "conflict";
    const title = branch === plan.recommendation ? `推荐` : `备选`;
    lines.push(`## Branch ${branch} — ${changed.length} change${changed.length === 1 ? "" : "s"} (${state}, ${title})`);
    const byAgent = new Map();
    for (const operation of changed) {
      const key = operation.agent ?? "共享";
      if (!byAgent.has(key)) byAgent.set(key, []);
      byAgent.get(key).push(operation);
    }
    for (const agent of inventory.agents.map((item) => item.id)) {
      const agentOperations = byAgent.get(agent) ?? [];
      const increment = plan.branches[branch][agent];
      lines.push(`- ${agent}`);
      if (!increment) lines.push("  - 增量: (empty)");
      if (!agentOperations.length) {
        if (increment) lines.push("  - 无文件改动");
        continue;
      }
      for (const operation of agentOperations) {
        lines.push(renderOperation(operation, plan, branch, templateContent, root));
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

async function preview(options) {
  const planPath = resolve(required(options.plan, "--plan"));
  const { plan, inventory, planDigest } = await loadPlan(planPath);
  const branchOperations = {};
  let valid = true;
  for (const branch of BRANCHES) {
    const operations = await evaluateBranch(plan, inventory, branch);
    const branchValid = operations.every((operation) => operation.action !== "conflict");
    valid &&= branchValid;
    branchOperations[branch] = operations;
  }
  const report = renderReport(plan, inventory, branchOperations, planDigest, valid);
  const reportPath = resolve(dirname(planPath), `${basename(planPath, ".json")}.preview.md`);
  await writeAtomic(reportPath, report);
  console.log(JSON.stringify({
    schema: "agent-prompt-sync-preview/6",
    planDigest,
    recommendation: plan.recommendation,
    valid,
    reportPath,
  }, null, 2));
  if (!valid) process.exitCode = 1;
}

function holderIsDead(holder) {
  const pid = Number.parseInt(holder, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== holder) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function malformedHolder(holder) {
  if (!/^[1-9]\d*$/.test(holder)) return true;
  return !Number.isSafeInteger(Number(holder));
}

async function acquireLock(root) {
  const paths = managedPaths(root);
  await mkdir(paths.stateRoot, { recursive: true });
  const pid = String(process.pid);
  const create = async () => {
    const handle = await open(paths.lock, "wx");
    try {
      await handle.writeFile(`${pid}\n`);
    } finally {
      await handle.close();
    }
  };
  try {
    await create();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let holder = "unknown";
    let metadata = null;
    try {
      [holder, metadata] = await Promise.all([
        readFile(paths.lock, "utf8").then((content) => content.trim() || "unknown"),
        lstat(paths.lock),
      ]);
    } catch {
      holder = "unknown";
    }
    const malformedIsStale = metadata && malformedHolder(holder) &&
      Date.now() - metadata.mtimeMs > 60_000;
    if (!holderIsDead(holder) && !malformedIsStale) {
      throw new Error(`agent-prompt-sync lock held by pid ${holder}`);
    }
    await unlink(paths.lock);
    await create();
  }
  return async () => {
    try {
      if ((await readFile(paths.lock, "utf8")).trim() === pid) await unlink(paths.lock);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

function backupOriginal(operation, currentStates, originalState = operation.current) {
  const original = {
    exists: originalState.exists,
    kind: originalState.kind,
    sha256: originalState.sha256 ?? null,
    linkTarget: originalState.linkTarget ?? null,
    resolvedLinkTarget: originalState.resolvedLinkTarget ?? null,
    payload: null,
    hardlinkTarget: null,
  };
  if (operation.kind === "link" && sameFile(originalState, currentStates[operation.targetRole])) {
    original.hardlinkTarget = operation.targetPath;
  }
  return original;
}

async function validateExistingBackup(backupRoot, manifest, expected) {
  if (manifest.schema !== "agent-prompt-sync-backup/2" ||
      manifest.planDigest !== expected.planDigest || manifest.branch !== expected.branch ||
      !Array.isArray(manifest.operations)) {
    throw new Error(`Existing backup does not match this apply operation: ${backupRoot}`);
  }
  const operationsByRole = new Map(expected.operations.map((operation) => [operation.role, operation]));
  const savedRoles = new Set();
  for (let index = 0; index < manifest.operations.length; index += 1) {
    const saved = manifest.operations[index];
    const operation = operationsByRole.get(saved.role);
    if (!operation || savedRoles.has(saved.role)) {
      throw new Error(`Existing backup contains an unknown or duplicate operation: ${saved.role}`);
    }
    savedRoles.add(saved.role);
    const expectedOriginal = backupOriginal(operation, expected.baseStates, operation.base);
    if (saved.path !== operation.path || !sameFingerprint(saved.original, operation.base) ||
        saved.original.hardlinkTarget !== expectedOriginal.hardlinkTarget) {
      throw new Error(`Existing backup state does not match ${operation.path}`);
    }
    if (operation.base.exists && operation.base.kind === "file") {
      if (saved.original.payload !== `payload-${index}.bin`) {
        throw new Error(`Existing backup payload path is invalid for ${operation.path}`);
      }
      const bytes = await readFile(resolve(backupRoot, saved.original.payload));
      if (sha256(bytes) !== operation.base.sha256) {
        throw new Error(`Existing backup payload is damaged for ${operation.path}`);
      }
    }
  }
  for (const operation of expected.changed) {
    if (!savedRoles.has(operation.role)) {
      throw new Error(`Existing backup does not cover ${operation.path}`);
    }
  }
  return manifest;
}

async function prepareBackup(backupRoot, operations, changed, currentStates, baseStates, planDigest, branch) {
  const manifestPath = resolve(backupRoot, "manifest.json");
  let existing;
  try {
    existing = (await readJson(manifestPath)).value;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Cannot read existing backup manifest: ${manifestPath}`);
    }
  }
  if (existing) {
    return validateExistingBackup(backupRoot, existing, {
      operations,
      changed,
      baseStates,
      planDigest,
      branch,
    });
  }

  let rootExists = true;
  try {
    await lstat(backupRoot);
  } catch (error) {
    if (error?.code === "ENOENT") rootExists = false;
    else throw error;
  }
  if (rootExists) throw new Error(`Backup directory exists without a readable manifest: ${backupRoot}`);

  await mkdir(dirname(backupRoot), { recursive: true });
  await mkdir(backupRoot);
  try {
    const entries = [];
    for (let index = 0; index < changed.length; index += 1) {
      const operation = changed[index];
      const original = backupOriginal(operation, currentStates);
      if (operation.current.exists) {
        if (operation.current.kind === "file") {
          original.payload = `payload-${index}.bin`;
          const bytes = await readFile(operation.path);
          if (sha256(bytes) !== operation.current.sha256) {
            throw new Error(`File changed while preparing backup: ${operation.path}`);
          }
          await writeFile(resolve(backupRoot, original.payload), bytes, { flag: "wx" });
        } else if (operation.current.kind !== "symlink") {
          throw new Error(`Cannot safely back up ${operation.current.kind}: ${operation.path}`);
        }
      }
      entries.push({
        role: operation.role,
        path: operation.path,
        action: operation.action,
        original,
      });
    }
    const manifest = {
      schema: "agent-prompt-sync-backup/2",
      planDigest,
      branch,
      status: "prepared",
      operations: entries,
    };
    await writeJson(manifestPath, manifest);
    return manifest;
  } catch (error) {
    await rm(backupRoot, { recursive: true, force: true });
    throw error;
  }
}

async function replaceLink(path, target, type) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  try {
    if (type === "hardlink") await createHardlink(target, temporary);
    else await createSymlink(target, temporary, "file");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function createManagedLink(operation) {
  const strategies = process.platform === "win32" ? ["hardlink", "symlink"] : ["symlink", "hardlink"];
  const errors = [];
  for (const strategy of strategies) {
    try {
      await replaceLink(operation.path, operation.targetPath, strategy);
      const current = await snapshot(operation.path);
      const target = await snapshot(operation.targetPath);
      if (!target.exists || target.kind !== "file") {
        throw new Error(`Managed link target is not a regular file: ${operation.targetPath}`);
      }
      if (strategy === "symlink" && current.kind === "symlink" &&
          current.resolvedLinkTarget === operation.targetPath) return "symlink";
      if (strategy === "hardlink" && sameFile(current, target)) return "hardlink";
      throw new Error(`Could not verify ${strategy} at ${operation.path}`);
    } catch (error) {
      errors.push(`${strategy}: ${error.message}`);
    }
  }
  throw new Error(`Unable to create a managed link at ${operation.path}; ${errors.join("; ")}`);
}

async function restoreOriginal(backupRoot, operation, deferredHardlinks) {
  const original = operation.original;
  if (!original.exists) {
    await rm(operation.path, { force: true });
    return;
  }
  if (original.hardlinkTarget) {
    deferredHardlinks.push(operation);
    return;
  }
  if (original.kind === "symlink") {
    await replaceLink(operation.path, original.linkTarget, "symlink");
    return;
  }
  if (original.kind === "file") {
    const bytes = await readFile(resolve(backupRoot, original.payload));
    if (sha256(bytes) !== original.sha256) throw new Error(`Damaged backup for ${operation.path}`);
    await writeAtomic(operation.path, bytes);
    return;
  }
  throw new Error(`Cannot restore ${original.kind}: ${operation.path}`);
}

async function rollback(backupRoot, manifest, attempted) {
  const byRole = new Map(manifest.operations.map((operation) => [operation.role, operation]));
  const deferredHardlinks = [];
  const errors = [];
  for (const operation of [...attempted].reverse()) {
    const saved = byRole.get(operation.role);
    if (!saved) {
      errors.push(`${operation.role}: missing backup entry`);
      continue;
    }
    try {
      await restoreOriginal(backupRoot, saved, deferredHardlinks);
    } catch (error) {
      errors.push(`${operation.role}: ${error.message}`);
    }
  }
  for (const saved of deferredHardlinks) {
    try {
      const target = await snapshot(saved.original.hardlinkTarget);
      if (target.sha256 !== saved.original.sha256) {
        throw new Error(`Hardlink target was not restored: ${saved.original.hardlinkTarget}`);
      }
      await replaceLink(saved.path, saved.original.hardlinkTarget, "hardlink");
    } catch (error) {
      errors.push(`${saved.role}: ${error.message}`);
    }
  }
  return errors;
}

async function apply(options) {
  const branch = required(options.branch, "--branch");
  if (!BRANCHES.includes(branch)) throw new Error("Branch must be A, B, or C");
  const confirmation = required(options.confirm, "--confirm");
  const planPath = resolve(required(options.plan, "--plan"));
  const initial = await loadPlan(planPath);
  if (confirmation !== initial.planDigest) throw new Error("Confirmation digest does not match this plan");
  const releaseLock = await acquireLock(initial.plan.root);
  try {
    const { plan, inventory, planDigest } = await loadPlan(planPath);
    if (confirmation !== planDigest) throw new Error("Confirmation digest does not match this plan");
    const operations = await evaluateBranch(plan, inventory, branch);
    const conflicts = operations.filter((operation) => operation.action === "conflict");
    if (conflicts.length) {
      throw new Error(`Files changed after scanning: ${conflicts.map((operation) => operation.role).join(", ")}`);
    }
    const changed = operations.filter((operation) => operation.action !== "unchanged");
    if (changed.length === 0) {
      console.log(JSON.stringify({ branch, changed: 0, unchanged: operations.length, backup: null, links: {} }, null, 2));
      return;
    }

    const backupRoot = resolve(
      managedPaths(plan.root).stateRoot,
      "backups",
      `${planDigest}-${branch}`,
    );
    const currentStates = Object.fromEntries(operations.map((operation) => [operation.role, operation.current]));
    const baseStates = Object.fromEntries(operations.map((operation) => [operation.role, operation.base]));
    const manifest = await prepareBackup(
      backupRoot,
      operations,
      changed,
      currentStates,
      baseStates,
      planDigest,
      branch,
    );
    const links = {};
    try {
      for (const operation of changed) {
        if (allowTestHooks(plan.root) &&
            process.env.AGENT_PROMPT_SYNC_TEST_CRASH_ROLE === operation.role) {
          const error = new Error(`Simulated crash at ${operation.role}`);
          error.agentPromptSyncCrash = true;
          throw error;
        }
        if (allowTestHooks(plan.root) &&
            process.env.AGENT_PROMPT_SYNC_TEST_FAIL_ROLE === operation.role) {
          throw new Error(`Injected failure at ${operation.role}`);
        }
        if (operation.kind === "file") {
          await writeAtomic(operation.path, operation.content);
        } else if (operation.kind === "absent") {
          await rm(operation.path, { force: true });
        } else if (operation.kind === "link") {
          links[operation.role] = await createManagedLink(operation);
        } else {
          throw new Error(`Cannot apply operation kind: ${operation.kind}`);
        }
      }
      await writeJson(resolve(backupRoot, "manifest.json"), { ...manifest, status: "completed" });
    } catch (error) {
      if (error.agentPromptSyncCrash) throw error;
      const rollbackErrors = await rollback(backupRoot, manifest, manifest.operations);
      throw new Error(
        `Apply failed: ${error.message}; ${rollbackErrors.length
          ? `rollback errors: ${rollbackErrors.join("; ")}`
          : "rollback completed"}`,
      );
    }

    console.log(JSON.stringify({
      branch,
      changed: changed.length,
      unchanged: operations.length - changed.length,
      backup: backupRoot,
      links,
      operations: changed.map(publicOperation),
    }, null, 2));
  } finally {
    await releaseLock();
  }
}

const [command, ...argv] = process.argv.slice(2);
const options = parseArgs(argv);
try {
  if (command === "scan") {
    await scan(options);
  } else if (command === "scaffold") {
    await scaffold(options);
  } else if (command === "preview") {
    await preview(options);
  } else if (command === "apply") {
    await apply(options);
  } else {
    throw new Error("Usage: prompt-sync.mjs scan|scaffold|preview|apply [options]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
