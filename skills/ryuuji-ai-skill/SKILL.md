---
name: ryuuji-ai-skill
description: RyuuAI's explicit entry for poteto-mode workflows, project-scoped MCP tasks, and storage audits. Use for /ryuuji-ai-skill or requests to enter RyuuAI.
disable-model-invocation: true
---

# RyuuAI

RyuuAI is a thin entry over pstack. Route each request once.

## RyuuAI extensions

Handle a request that clearly matches one of these extensions by reading the referenced file in full and following it. Do not also enter `poteto-mode` for that request.

- **Storage audit.** Directory redundancy, reclaimable space, archive copies, or storage cleanup analysis. Read `../storage-audit/SKILL.md`.
- **Project-scoped MCP.** A task needs an MCP server that should connect only for a delegated task. Read `references/scoped-mcp.md`, select the matching pre-registered project agent, and delegate the task instead of running it in the parent chat.

For a mixed request, split it into explicit tasks and route each task once.

## pstack fallback

For every other request, read `../poteto-mode/SKILL.md` once and follow it as the mode's only playbook router. Do not independently select another playbook after entering it.

When this entry spawns a `poteto-agent`, pass the absolute path of `../poteto-mode/SKILL.md`, resolved from this file, not the path of this alias.
