import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "RYUUJI_MCP_FIXTURE_OK";
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 240_000;
const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "fixture-server.mjs");
const claudeCommand = process.execPath;
const npxCliPath =
  process.env.npm_execpath ??
  (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")
    : join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"));
const claudePrefix = [npxCliPath, "--yes", "@anthropic-ai/claude-code@2.1.302"];

function yamlString(value) {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

function runClaude({ cwd, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeCommand, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGKILL");
      }
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function parseEvents(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function truncate(text) {
  return text.length > 4_000 ? text.slice(-4_000) : text;
}

async function runAttempt() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ryuuji-scoped-mcp-"));
  const project = join(temporaryRoot, "project");
  const logPath = join(temporaryRoot, "fixture-events.jsonl");
  let stdout = "";
  let stderr = "";
  let events = [];

  try {
    const agentDirectory = join(project, ".claude", "agents");
    await mkdir(agentDirectory, { recursive: true });

    const agentName = "mcp-fixture";
    const agent = `---
name: ${agentName}
description: Test-only agent that calls the scoped fixture MCP once and returns its marker.
tools: Bash, mcp__fixture__*
mcpServers:
  - fixture:
      type: stdio
      command: ${yamlString(process.execPath)}
      args: [${yamlString(serverPath)}]
      env:
        RYUUJI_MCP_FIXTURE_LOG: ${yamlString(logPath)}
---

First run the Bash command 'sleep 3'. Then call the fixture_mark MCP tool exactly once and return only its text marker.
`;
    await writeFile(join(agentDirectory, `${agentName}.md`), agent, "utf8");

    const prompt = [
      `Use the Agent tool exactly once with subagent_type '${agentName}'.`,
      "Ask that agent to follow its instructions and return only the marker.",
      "Do not call any MCP tool yourself.",
      "After the agent returns, run the Bash command 'sleep 3' exactly once.",
      "Then reply with only the marker returned by the agent.",
    ].join(" ");

    const args = [
      ...claudePrefix,
      "-p",
      prompt,
      "--output-format",
      "json",
      "--no-session-persistence",
      "--max-turns",
      "8",
      "--permission-prompts",
      "none",
      "--allowedTools",
      "Agent",
      "--allowedTools",
      "Bash(sleep 3)",
      "--allowedTools",
      "mcp__fixture__*",
    ];

    const completed = await runClaude({ cwd: project, args });
    const parentExitedAt = Date.now();
    stdout = completed.stdout;
    stderr = completed.stderr;
    events = parseEvents(await readFile(logPath, "utf8").catch(() => ""));

    assert.equal(completed.timedOut, false, "Claude Code timed out");
    assert.equal(completed.code, 0, `Claude Code exited with ${completed.code}: ${stderr}`);

    let output;
    try {
      output = JSON.parse(stdout);
    } catch {
      throw new Error(`Claude Code did not return JSON: ${stdout}`);
    }

    assert.equal(
      String(output.result ?? "").trim(),
      MARKER,
      `Unexpected final result: ${JSON.stringify(output)}`,
    );

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

    const disconnect = events[disconnectIndex];
    const disconnectedBeforeParentExitMs = parentExitedAt - disconnect.at;
    assert.ok(
      disconnectedBeforeParentExitMs >= 1_500,
      `MCP disconnected only ${disconnectedBeforeParentExitMs} ms before parent exit; it did not stop with the subagent`,
    );

    return {
      result: output.result,
      disconnectEvent: disconnect.event,
      disconnectedBeforeParentExitMs,
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
    console.log(JSON.stringify({ attempt, ...summary }, null, 2));
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
