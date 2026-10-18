---
name: agent-prompt-sync
description: Analyze actual agents' user-level prompts and maintain one Ryuuji canonical prompt with native links and per-agent increments. Use for /agent-prompt-sync, multi-agent prompt migration, prompt consolidation, or replacing user instructions with Ryuuji's rules.
disable-model-invocation: true
---

# Agent prompt sync

Maintain one runtime canonical prompt without changing agent installations. The release template is `references/ryuuji-user-prompt.md`; change that file only when the operator explicitly asks to update the template. The runtime canonical file is `~/.claude/CLAUDE.md`; apply writes it only when `claude-code` is in the inventory `agents` list.

| Agent | Canonical entry | Managed increment |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` is the canonical file | `~/.claude/rules/agent-prompt-sync.md` |
| Codex | `~/.codex/AGENTS.md` links to `~/.agent-prompt-sync/generated/codex/AGENTS.md`, which contains canonical + increment | The increment exists only inside the generated composite |
| Cursor | `~/.cursor/rules/ryuuji.mdc` links to a generated `alwaysApply: true` wrapper | `~/.cursor/rules/agent-prompt-sync.mdc` |
| OpenCode | `~/.config/opencode/AGENTS.md` links to `~/.agent-prompt-sync/generated/opencode/AGENTS.md`, which contains the canonical content | `~/.config/opencode/rules/agent-prompt-sync.md`, registered by absolute path in `opencode.jsonc` if that file exists, otherwise `opencode.json` `instructions` |

An empty increment means the managed increment file is absent. OpenCode's generated entry keeps Windows hardlinks off `~/.claude/CLAUDE.md`, so the Claude canonical file remains a regular file for Claude Code and Cowork. Codex `AGENTS.override.md` is linked to the same composite only when it already exists; never create an override. Cursor's legacy `~/.cursor/AGENTS.md` is analysis input and is backed up before removal. Cursor unmanaged `.mdc` files and unmanaged `~/.claude/rules/*.md` files are analysis input only and are not modified. If a local copy of Cursor account User Rules has content, preview is invalid and apply is refused until the operator moves keep rules into the increment, clears Customize → Rules, and scans again. Cloud-synced User Rules are not writable; check Customize after apply. OpenCode's other config fields and instruction entries are preserved. If `opencode.jsonc` exists it is the file OpenCode loads; `opencode.json` is left unchanged. A required config change is rewritten as JSON.

An agent is detected by an existing prompt file or a command on PATH. Empty configuration directories do not prove installation. Detection is evidence of configuration, not proof of active use. If the operator identifies an unused residual agent, remove only its entry from the temporary inventory's `agents` array, record it in `excludedAgents` with the operator's reason, and rerun scaffold; leave every file for that agent unchanged. A later `scan` to the same inventory file keeps `excludedAgents` and omits those agents. Other detected commands are reported as unsupported and left unchanged.

## 1. Scan and scaffold

Resolve this skill's directory as `SKILL_ROOT` and create a temporary working directory. Inventory stores full text only for analysis sources, the template, and OpenCode config; keep inventory and plan files local and delete them when the workflow ends.

```bash
node "$SKILL_ROOT/scripts/prompt-sync.mjs" scan \
  --output "$SYNC_TMP/inventory.json"
node "$SKILL_ROOT/scripts/prompt-sync.mjs" scaffold \
  --inventory "$SYNC_TMP/inventory.json" \
  --output "$SYNC_TMP/plan.json"
```

Stop if no supported agent is detected. Invalid UTF-8 prompts stop the workflow instead of being rewritten. Report unsupported agents instead of guessing their prompt paths.

## 2. Analyze before choosing increments

Read the inventory and plan files. Do not paste inventory or plan JSON into the conversation. For every detected agent, classify current rules, including `preserved` files and Cursor account User Rules when a local copy was captured:

- Duplicate of the Ryuuji template.
- Necessary personal or agent-specific behavior to retain.
- Redundant, stale, or conflicting content to drop.
- Differences required by the agent's native tools or runtime.

Complete every `analysis` entry with `keep`, `drop`, and a non-empty `rationale`. Remove every scaffold `TODO`. If Cursor account User Rules blocked preview, clear Customize → Rules and scan again before apply.

Edit the branches as increments, not complete prompt files:

- **A — Ryuuji only.** Keep every increment empty.
- **B — Conservative increment.** Preserve non-duplicate existing rules conservatively, without repeating the canonical template.
- **C — Minimum necessary increment.** Retain only rules proven necessary by the analysis.

Set `recommendation` to **A** when no original rule is necessary, otherwise **C**. Present B without recommending it.

## 3. Dry-run all branches

```bash
node "$SKILL_ROOT/scripts/prompt-sync.mjs" preview \
  --plan "$SYNC_TMP/plan.json"
```

Preview does not write agent targets or backups. It writes a markdown report next to the plan and prints `reportPath`, `planDigest`, `valid`, `recommendation`, and `warnings`. If a target or the template changed after scanning, scan and build a fresh plan instead of overwriting anything.

Read the file at `reportPath` and paste that markdown into the conversation verbatim. Do not paste preview JSON, inventory JSON, or a one-line status. Dry-run is not done until the operator has seen this report, including recommendation, warnings, excluded agents, analysis, A/B/C increments, and the recommended branch's file diffs. Then wait for the operator to choose A, B, or C.

## 4. Apply only after explicit confirmation

After the operator selects A, B, or C, show the selected branch, target paths, deletions, and `planDigest`, then ask for explicit confirmation. Only after that confirmation run:

```bash
node "$SKILL_ROOT/scripts/prompt-sync.mjs" apply \
  --plan "$SYNC_TMP/plan.json" \
  --branch "$SELECTED_BRANCH" \
  --confirm "$PLAN_DIGEST"
```

`apply` holds the manager lock, rechecks the plan, template, and current states, and backs up original bytes and links under `~/.agent-prompt-sync/backups/<planDigest>-<branch>/` before changing targets. Live or freshly malformed locks are refused; dead-PID locks and malformed locks older than 60 seconds are reclaimed. Existing backups are validated and never overwritten. A prepared backup lets a later apply validate the original payloads and resume remaining operations after a crash. A caught failure rolls back the whole transaction; a successful retry leaves already matching state unchanged.

POSIX uses symlinks preferentially. Windows uses same-volume hardlinks preferentially and can fall back to symlinks. If neither link works, apply fails and rolls back instead of creating an unmanaged copy. Replacing a canonical or generated file also refreshes dependent hardlinks.

Return changed/unchanged counts, link types, and the backup path. Do not modify agents, delete their installations, edit targets directly, or bypass `apply`.
