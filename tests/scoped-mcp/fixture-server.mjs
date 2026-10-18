import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MARKER = "RYUUJI_MCP_FIXTURE_OK";
const logPath = process.env.RYUUJI_MCP_FIXTURE_LOG;

if (!logPath) {
  throw new Error("RYUUJI_MCP_FIXTURE_LOG is required");
}

mkdirSync(dirname(logPath), { recursive: true });

function record(event, extra = {}) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ event, at: Date.now(), pid: process.pid, ...extra })}\n`,
    "utf8",
  );
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function handle(message) {
  const { id, method, params = {} } = message;

  if (method === "initialize") {
    record("initialize");
    result(id, {
      protocolVersion:
        typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "ryuuji-scoped-mcp-fixture", version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    record("initialized");
    return;
  }

  if (method === "tools/list") {
    record("tools-list");
    result(id, {
      tools: [
        {
          name: "fixture_mark",
          description: "Return one fixed marker used by the scoped MCP lifecycle test.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }

  if (method === "tools/call" && params.name === "fixture_mark") {
    record("call", { tool: "fixture_mark" });
    result(id, {
      content: [{ type: "text", text: MARKER }],
      isError: false,
    });
    return;
  }

  if (method === "ping") {
    result(id, {});
    return;
  }

  if (id !== undefined && id !== null) {
    record("unsupported", { method });
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported method: ${method}` },
    });
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  while (true) {
    const newline = buffered.indexOf("\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      record("error", { message: error instanceof Error ? error.message : String(error) });
    }
  }
});

process.stdin.on("end", () => {
  record("stdin-end");
  setTimeout(() => process.exit(0), 20);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    record(signal.toLowerCase());
    process.exit(0);
  });
}

process.on("exit", (code) => {
  record("exit", { code });
});

record("start");
