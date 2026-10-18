# Independent MCP task sessions

Use a separate `claude -p` process when a task needs its own MCP configuration and session lifecycle. The parent chat keeps its existing session and MCP servers.

## Start one isolated task

Write a task-specific config in a new temporary directory:

```json
{
  "mcpServers": {
    "project-private": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/absolute/path/to/project-mcp-server.js"]
    }
  }
}
```

Run one fresh process for the task:

```bash
claude -p "$TASK" \
  --output-format json \
  --mcp-config "$TASK_MCP_CONFIG" \
  --strict-mcp-config \
  --no-session-persistence \
  --tools "" \
  --allowedTools "mcp__project-private__*" \
  --permission-prompts none
```

- `--mcp-config` selects the explicit config. `--strict-mcp-config` prevents ambient user, project, or enterprise MCP configs from being added.
- `--tools ""` disables built-in tools while leaving the explicit MCP tools available. `--allowedTools` only auto-approves matching permission requests; it is not a tool whitelist and must not replace `--tools`.
- If the task needs built-in tools, replace `--tools ""` with a comma-separated minimum set such as `--tools "Read,Grep"`. Add only the permissions required for that task.
- `--no-session-persistence` is appropriate for a one-off task. Omit it only when the operator intentionally needs a resumable session and will manage that session explicitly.
- `--permission-prompts none` keeps the independent run non-interactive. Collect operator approval before delegating irreversible or outward-facing work.

## Finish and clean up

Wait for the Claude Code process to exit and confirm its MCP server has stopped. On timeout, terminate the owned process tree before cleaning up. Remove the temporary config and task directory; never delete a persistent config supplied by the operator.

Return only the JSON result summary or declared artifact paths to the parent. Start a fresh process and temporary config for each independent task.
