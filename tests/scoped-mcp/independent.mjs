import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudePrefix,
  MARKER,
  readEvents,
  runClaude,
  truncate,
} from "./helpers.mjs";

const MAX_ATTEMPTS = 3;
const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "fixture-server.mjs");

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sessionFileExists(sessionId) {
  assert.ok(sessionId, "Claude Code did not return a session_id");
  const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  let entries;
  try {
    entries = await readdir(join(configRoot, "projects"), {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return entries.some(
    (entry) => entry.isFile() && entry.name === `${sessionId}.jsonl`,
  );
}

function mcpConfig(logPath) {
  return {
    mcpServers: {
      fixture: {
        type: "stdio",
        command: process.execPath,
        args: [serverPath],
        env: { RYUUJI_MCP_FIXTURE_LOG: logPath },
      },
    },
  };
}

function claudeArgs({ configPath, prompt, maxTurns }) {
  return [
    ...claudePrefix,
    "-p",
    prompt,
    "--output-format",
    "json",
    "--mcp-config",
    configPath,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-turns",
    String(maxTurns),
    "--permission-prompts",
    "none",
    "--tools",
    "",
    "--allowedTools",
    "mcp__fixture__*",
  ];
}

function parseOutput(stdout, stderr, completed) {
  assert.equal(completed.timedOut, false, "Claude Code timed out");
  assert.equal(completed.code, 0, `Claude Code exited with ${completed.code}: ${stderr}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Claude Code did not return JSON: ${stdout}`);
  }
}

async function runAttempt() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ryuuji-independent-mcp-"));
  const project = join(temporaryRoot, "project");
  const configPath = join(temporaryRoot, "mcp.json");
  const logPath = join(temporaryRoot, "fixture-events.jsonl");
  const ambientLogPath = join(temporaryRoot, "ambient-events.jsonl");
  const canaryPath = join(project, "canary.txt");
  let stdout = "";
  let stderr = "";
  let events = [];

  try {
    await mkdir(project, { recursive: true });
    await writeFile(configPath, JSON.stringify(mcpConfig(logPath)), "utf8");
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          ambient: {
            type: "stdio",
            command: process.execPath,
            args: [serverPath],
            env: { RYUUJI_MCP_FIXTURE_LOG: ambientLogPath },
          },
        },
      }),
      "utf8",
    );

    const completed = await runClaude({
      cwd: project,
      args: claudeArgs({
        configPath,
        prompt: "Call the fixture_mark MCP tool exactly once and return only its text marker. Do not use any other tool.",
        maxTurns: 4,
      }),
    });
    stdout = completed.stdout;
    stderr = completed.stderr;
    const output = parseOutput(stdout, stderr, completed);
    assert.equal(
      String(output.result ?? "").trim(),
      MARKER,
      `Unexpected final result: ${JSON.stringify(output)}`,
    );
    assert.equal(
      await sessionFileExists(output.session_id),
      false,
      "Claude Code persisted the independent session",
    );

    events = await readEvents(logPath);
    const startIndex = events.findIndex((event) => event.event === "start");
    const callIndex = events.findIndex(
      (event) => event.event === "call" && event.tool === "fixture_mark",
    );
    const disconnectIndex = events.findIndex(
      (event, index) =>
        index > callIndex &&
        ["stdin-end", "sigint", "sigterm", "exit"].includes(event.event),
    );
    assert.ok(startIndex >= 0, "Fixture MCP did not start");
    assert.ok(callIndex > startIndex, "Fixture MCP was not called");
    assert.ok(disconnectIndex > callIndex, "Fixture MCP did not disconnect after the call");
    assert.equal(
      await pathExists(ambientLogPath),
      false,
      "Strict MCP mode connected the ambient project server",
    );

    const denied = await runClaude({
      cwd: project,
      args: claudeArgs({
        configPath,
        prompt: `Use the Bash tool to run exactly this command: node -e "require('fs').writeFileSync('canary.txt','blocked')". Do not use any MCP tool.`,
        maxTurns: 3,
      }),
    });
    stdout = denied.stdout;
    stderr = denied.stderr;
    const deniedOutput = parseOutput(stdout, stderr, denied);
    assert.equal(
      await pathExists(canaryPath),
      false,
      "The non-whitelisted Bash command wrote a file",
    );
    assert.equal(
      await sessionFileExists(deniedOutput.session_id),
      false,
      "Claude Code persisted the permission-check session",
    );
    assert.equal(
      await pathExists(ambientLogPath),
      false,
      "Strict MCP mode connected the ambient project server",
    );

    return {
      result: output.result,
      disconnectEvent: events[disconnectIndex].event,
      builtInToolsDisabled: true,
      ambientMcpStarted: false,
      sessionFilesPersisted: false,
      temporaryRoot,
      events: events.map(({ event, at, tool }) => ({ event, at, tool })),
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.details = { stdout: truncate(stdout), stderr: truncate(stderr), events };
    throw failure;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const failures = [];
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  try {
    const summary = await runAttempt();
    assert.equal(
      await pathExists(summary.temporaryRoot),
      false,
      "The independent-session temporary directory was not removed",
    );
    console.log(JSON.stringify({ attempt, ...summary, temporaryRootRemoved: true }, null, 2));
    break;
  } catch (error) {
    failures.push({
      attempt,
      error: error instanceof Error ? error.message : String(error),
      details: error instanceof Error ? error.details : undefined,
    });
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } else {
      console.error(JSON.stringify({ failures }, null, 2));
      process.exitCode = 1;
    }
  }
}
