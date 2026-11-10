---
name: agent-prompt-sync
description: 分析本机各 agent 的用户级提示词，展示预期内容，并生成独立可编辑的普通文件。用户提到用户级提示词、提示词迁移、提示词精简或提示词同步时使用。
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
disable-model-invocation: true
---

# 用户级提示词同步

读取现状，分析内容，经用户确认后写出各 agent 的提示词。每个目标都是独立可编辑的普通文件，不使用链接，不维护同步状态。

## 文件位置

| Agent | 用户级文件 | 写入形式 |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | Markdown |
| Codex | `~/.codex/AGENTS.md` | Markdown |
| Cursor | `~/.cursor/rules/ryuuji.mdc` | `alwaysApply: true` frontmatter 加 Markdown |
| OpenCode | `~/.config/opencode/AGENTS.md` | Markdown |

同时读取已有的 Claude `~/.claude/rules/*.md`、Cursor 其他 `.mdc`、Codex `AGENTS.override.md` 和 OpenCode `instructions` 引用的文件，把它们纳入分析。不要主动新建 Codex override。

## 流程

1. 读取现有提示词。分析哪些内容应共用，哪些只属于某个 agent，哪些重复、冲突或过时。
2. 需要共同基础时，可以采用 `references/ryuuji-user-prompt.md` 或一份现有提示词。它只是本次内容的来源，不限制任何文件之后的编辑。
3. 在对话中列出每个目标路径，并贴出预期完整内容。需要删除的冗余文件或配置项也一并列出。等用户确认。
4. 确认后用 Write 或 Edit 写入最终内容。目标是 symlink 或 hardlink 时，先解除该链接，再创建同名普通文件，不要写入链接目标。
5. 读回写过的文件，核对与确认的内容一致。

下次同步以当时的文件内容为准。只有用户明确要求更新模板时，才修改 `references/ryuuji-user-prompt.md`。
