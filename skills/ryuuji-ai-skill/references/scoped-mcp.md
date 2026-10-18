# Project-scoped MCP agents

Use a project agent when an MCP server belongs to one delegated task rather than the parent chat. The parent keeps its existing persistent MCP servers unchanged.

## Register the agent before the session

Place the agent in the consuming project's `.claude/agents/`. Do not put scoped MCP configuration in a plugin-provided agent: Claude Code ignores `mcpServers` on plugin subagents.

```yaml
---
name: project-mcp-task
description: Runs the project task that needs its private MCP server. Use only when RyuuAI routes that task here.
tools: Bash, mcp__project-private__*
mcpServers:
  - project-private:
      type: stdio
      command: node
      args: ["C:/absolute/path/to/project-mcp-server.js"]
---

Run `sleep 3` before the first MCP call so the inline server can finish connecting. Then perform the delegated task and return only the result summary and any artifact paths.
```

An inline server connects when this subagent starts and disconnects when it finishes. Its tools and detailed output stay out of the parent chat; the parent receives the subagent's final report.

Do not replace the inline mapping with a string reference such as `mcpServers: [project-private]`. A string reference reuses the parent session's configured connection.

A new agent definition is discovered at session startup. After creating or changing one, use it from a new session.

## Keep the project idle by default

- Keep task-only MCP configuration in the agent, not in an always-enabled parent `.mcp.json` entry.
- Give project extension skills `disable-model-invocation: true`. Read their `SKILL.md` only when RyuuAI selects them.
- Agent and skill names and descriptions may remain visible as metadata. Their skill bodies and inline MCP servers stay inactive until used.

## Delegate with a narrow contract

The parent owns routing, persistent state, user approval, and any shared writes. Give the subagent a complete task brief, required inputs, acceptance checks, and allowed write scope. Collect operator approval before delegation when the task has irreversible or outward-facing effects.

Ask for a concise result or artifact path rather than raw tool output. Start a fresh subagent for each independent task so its inline MCP lifecycle ends with that task.
