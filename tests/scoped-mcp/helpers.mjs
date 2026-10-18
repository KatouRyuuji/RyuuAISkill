import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const MARKER = "RYUUJI_MCP_FIXTURE_OK";
export const TIMEOUT_MS = 240_000;

const claudeCommand = process.execPath;
const npxCliPath =
  process.env.npm_execpath ??
  (process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")
    : join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"));

export const claudePrefix = [
  npxCliPath,
  "--yes",
  "@anthropic-ai/claude-code@2.1.302",
];

export function runClaude({ cwd, args }) {
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

export async function readEvents(logPath) {
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function truncate(text) {
  return text.length > 4_000 ? text.slice(-4_000) : text;
}
