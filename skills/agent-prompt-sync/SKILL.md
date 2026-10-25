---
name: agent-prompt-sync
description: 分析本机各 agent 的用户级提示词，维护一份 Ryuuji 正本，并用原生链接和每 agent 增量同步。用户提到用户级提示词、提示词迁移、提示词精简或提示词同步时使用。
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
disable-model-invocation: true
---

# 用户级提示词同步

维护一份运行时正本。不改任何 agent 的安装。

需要 Node.js 18 或更新版本，`node` 要在 PATH 上。

发布模板是 `references/ryuuji-user-prompt.md`。只有操作者明确要求更新模板时，才改这个文件。运行时正本是 `~/.claude/CLAUDE.md`。`apply` 只在清单 `agents` 含有 `claude-code` 时写入这份正本。

按顺序做完下面四步。

1. `scan`，再 `scaffold`。
2. 读清单和计划，写分析，填 A/B/C 增量。
3. `preview`，把报告原文贴进对话，等操作者选 A、B 或 C。
4. 展示所选分支并再次取得明确确认后，才 `apply`。

## 平台落点

| Agent | 正本入口 | 托管增量 |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` 就是正本文件 | `~/.claude/rules/agent-prompt-sync.md` |
| Codex | 增量为空时，`~/.codex/AGENTS.md` 硬链接到 `~/.claude/CLAUDE.md`。Codex 不展开 `@`，只读这一份全局文件 | 增量非空时才写入 `~/.agent-prompt-sync/generated/codex/AGENTS.md`，入口改链到这份 composite，不再同时链向正本 |
| Cursor | `~/.cursor/rules/ryuuji.mdc` 链接到生成文件。生成文件是 `alwaysApply: true` 加正本正文。Cursor 不把 `@` 读进上下文 | `~/.cursor/rules/agent-prompt-sync.mdc` |
| OpenCode | `~/.config/opencode/AGENTS.md` 链接到 `~/.agent-prompt-sync/generated/opencode/AGENTS.md`。该文件是正本内容 | `~/.config/opencode/rules/agent-prompt-sync.md`。存在 `opencode.jsonc` 时，用绝对路径登记进它的 `instructions`；否则登记进 `opencode.json` 的 `instructions` |

增量内容为空时，对应的托管增量文件不存在。

Claude Code 加载用户正本，也加载祖先目录上的 `CLAUDE.md` 和 `AGENTS.md`。不要在祖先目录再放一份同样的正文，否则会和 `~/.claude/CLAUDE.md` 一起加载。Cursor 3.18 只从项目目录向上扫到盘符根；`~/.cursor/rules` 不在这条链上时不会加载。规则正文必须写在扫得到的 `.mdc` 里。

## 保持不动

- Cursor 未托管的 `.mdc`，以及 `~/.claude/rules/*.md` 里未托管的文件：只作分析输入，不修改。
- Cursor 旧的 `~/.cursor/AGENTS.md`：只作分析输入。删除前会先备份。
- Codex 的 `AGENTS.override.md`：只有它已经存在时，才链接到同一份 composite。不要新建 override。
- OpenCode 的生成入口在 Windows 上不会硬链接到 `~/.claude/CLAUDE.md`，因此正本保持为普通文件。
- 检测到、但不在上表里的命令：报告为不支持，保持原样。不要猜测它们的提示词路径。

## 1. 扫描并生成计划

`${CLAUDE_SKILL_DIR}` 是 Claude Code 展开的 skill 目录，`SYNC_TMP` 是临时工作目录的绝对路径，换成实际路径再执行。命令写成单行、双引号包路径、路径用 `/`。在 bash、zsh、PowerShell 和 cmd 里，把 `${CLAUDE_SKILL_DIR}` 换成 skill 的绝对路径即可原样运行。

脚本自己会建 `SYNC_TMP` 目录，不用事先创建。不要通读 `prompt-sync.mjs`，按本文的说明调用即可。

```bash
node "${CLAUDE_SKILL_DIR}/scripts/prompt-sync.mjs" scan --output "<SYNC_TMP>/inventory.json"
node "${CLAUDE_SKILL_DIR}/scripts/prompt-sync.mjs" scaffold --inventory "<SYNC_TMP>/inventory.json" --output "<SYNC_TMP>/plan.json"
```

清单只为分析来源、模板和 OpenCode 配置保存全文。清单和计划留在本地，流程结束时删掉。

没有检测到受支持的 agent 时，停止。现有提示词不是合法 UTF-8 时，停止，不要改写。

判定是否安装：已有提示词文件，或命令在 PATH 上。空的配置目录不能证明已安装。检测到只说明有配置，不能证明正在使用。

操作者指出某个 agent 是不用的残留时：

1. 只从临时清单的 `agents` 数组去掉这一项。
2. 在 `excludedAgents` 记下该 agent 和操作者给出的原因。
3. 重新跑 `scaffold`。
4. 该 agent 的所有文件保持不动。

之后对同一份清单文件再跑 `scan` 时，保留 `excludedAgents`，并不再列入这些 agent。

## 2. 先分析，再写增量

读清单和计划。不要把清单 JSON 或计划 JSON 贴进对话。

对每个检测到的 agent 分类现有规则。范围包括 `preserved` 文件：

- 与 Ryuuji 模板重复。
- 必须保留的个人规则，或该 agent 特有的行为。
- 冗余、过时或冲突、应丢掉的内容。
- 该 agent 的原生工具或运行时要求的差异。

每个 `analysis` 条目都要有 `keep`、`drop` 和非空 `rationale`。删掉 scaffold 留下的每个 `TODO`。`references/plan-example.md` 是一份填好的完整计划，照它的写法改。

改 `plan.json` 里的分支。写入的是增量，不是完整提示词。增量字符串只写规则正文。Cursor 的 `alwaysApply` 头由脚本加上，不要写进增量。

| 分支 | 增量里放什么 |
|---|---|
| A | 每个增量都为空。只使用 Ryuuji 正本 |
| B | 保守保留不重复的现有规则，且不重复正本模板。展示它，不要把它写成 `recommendation` |
| C | 只保留分析证明有必要的规则 |

没有任何原有规则有必要保留时，`recommendation` 设为 `A`。否则设为 `C`。`recommendation` 只能是 `A` 或 `C`。

分析和分支必须一致。脚本在加载计划时核对四条：`keep` 的每条规则都在 `B` 的增量里；`C` 增量里的每条规则都在 `keep` 里；`B` 包含 `C` 的全部规则；同一条规则不同时出现在 `keep` 和 `drop`。不满足就拒绝，报错会指出哪条规则、哪个 agent。

OpenCode 配置里的其他字段和其他 instruction 条目保持原样。存在 `opencode.jsonc` 时，OpenCode 加载的是它，`opencode.json` 保持不动。必须改配置时，把结果写成 JSON。

## 3. 三个分支都做 dry-run

```bash
node "${CLAUDE_SKILL_DIR}/scripts/prompt-sync.mjs" preview --plan "<SYNC_TMP>/plan.json"
```

`preview` 不写 agent 目标文件，也不写备份。它在计划旁边写一份 markdown 报告，并打印 `reportPath`、`planDigest`、`valid` 和 `recommendation`。

扫描之后，目标文件或模板变了：重新 scan，并生成新计划。不要覆盖已经变掉的内容。

读 `reportPath` 指向的文件，把那份 markdown 原样贴进对话。不要贴 preview JSON、清单 JSON，或一行状态。

操作者看到报告之后，dry-run 才算完成。报告依次给出：推荐分支与能否 apply、选项对比表、三个分支共有且不受选择影响的改动、每个选项独有的改动、每个 agent 的 `keep` 和 `drop` 判定表。改动相同的分支合并成一栏，报告写明实际有几个选项。只含公共改动的选项不单列章节。直接引用正本的条目显示为「正本原文」，不再重复打印。然后停下来，等操作者选择 A、B 或 C。

报告写明某几个分支改动完全相同时，按合并后的选项提问，不要让操作者区分内容一样的两个分支。只有 B 等于 C、A 与它们不同时，按报告的建议把 B 改成更保守的版本，或直接说明二者等价。

`valid` 不是 `true` 时，告诉操作者这一轮不能 apply。目标或模板在扫描后变了时，重新 scan 并做新计划。

## 4. 明确确认之后才 apply

操作者选定分支后，先展示所选分支、目标路径、将删除的路径和 `planDigest`，并再要一次明确确认。只有这次确认之后才运行：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/prompt-sync.mjs" apply --plan "<SYNC_TMP>/plan.json" --branch "<SELECTED_BRANCH>" --confirm "<PLAN_DIGEST>"
```

`apply` 会拿管理锁，并再次核对计划、模板和当前文件状态。改目标之前，把原始字节和链接备份到 `~/.agent-prompt-sync/backups/<planDigest>-<branch>/`。

- 活着的锁，以及刚产生的畸形锁：拒绝。
- 持有者 PID 已死的锁，以及超过 60 秒的畸形锁：回收。
- 已有备份要先校验，且永不覆盖。
- 已经备好的备份可以让下一次 apply 校验原始载荷，并在崩溃后继续剩下的操作。
- 捕获到的失败会回滚整个事务。成功重试时，已经一致的状态保持不变。
- POSIX 优先用 symlink，失败再试 hardlink。Windows 优先用同卷 hardlink，失败再试 symlink。
- 两种链接都失败时，apply 失败并回滚。不要生成一份不受管理的副本。
- 替换正本或生成文件时，同时刷新依赖它的 hardlink。

回报变更数、未变更数、链接类型和备份路径。不要改 agent 程序，不要删除安装。

## 附加文件

- `references/ryuuji-user-prompt.md`：发布模板正文。只在操作者明确要求更新模板时读改。
- `references/plan-example.md`：一份填好的 `plan.json` 和五条校验规则。第 2 步照着改时读。
- `scripts/prompt-sync.mjs`：四个子命令的实现。运行，不要通读。
