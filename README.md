# RyuuAISkill

RyuuAISkill 是我长期维护的 Agent Skill 合集。它以显式的 `/ryuuji-ai-skill` 为统一入口，保留完整的 `/poteto-mode`，并提供存储审计和项目级按需 MCP 扩展方式。

Claude Code 是首要目标平台；仓库同时保留 pstack 对其他 harness 的兼容说明。

## 为什么做这个合集

这个合集解决四个实际问题：

- **入口集中**：通用工作流从同一个显式入口进入，不要求每个扩展都成为新的主入口。
- **项目默认干净**：扩展 skill 正文和任务级 MCP 默认不加载、不连接；名称和描述可以作为元数据存在。
- **任务隔离**：需要临时 MCP 的工作交给子代理，详细工具输出不进入主会话，子代理结束后 MCP 断开。
- **复用成熟实现**：保留 poteto-mode 的 playbooks、principles、子代理和 `orch` 状态体系，不重写一套相似架构。

## 包含什么

| 内容 | 作用 |
|---|---|
| [`/ryuuji-ai-skill`](./skills/ryuuji-ai-skill/SKILL.md) | RyuuAI 的显式统一入口，负责扩展路由和 poteto-mode 回退 |
| [`/poteto-mode`](./skills/poteto-mode/SKILL.md) | 原有的完整工程编排入口，可独立使用 |
| [`/storage-audit`](./skills/storage-audit/SKILL.md) | 只读分析目录冗余、缓存、压缩包副本和存储空间 |
| [Scoped MCP 约定](./skills/ryuuji-ai-skill/references/scoped-mcp.md) | 使用项目子代理的 inline `mcpServers`，在任务期间连接 MCP |
| [`tests/scoped-mcp`](./tests/scoped-mcp/) | 验证 inline MCP 的连接、调用和子代理结束断开 |

`/poteto-mode` 没有被 `/ryuuji-ai-skill` 替代。你可以继续直接使用它。

## 安装

使用 [`skills` CLI](https://skills.sh) 安装：

```bash
npx skills add KatouRyuuji/RyuuAISkill
```

安装器会列出可选择的 skills。使用完整 RyuuAI 路由时，选择 `ryuuji-ai-skill`、`poteto-mode`、`storage-audit` 及其依赖；只需要某个独立 skill 时，可以只安装它和所需依赖。

## 使用

### 统一入口

```text
/ryuuji-ai-skill 对 D:\data 做 quick 存储审计，不写报告文件
```

RyuuAI 目前这样路由：

- 存储分析 → `storage-audit`。
- 需要任务级 MCP → 对应的预注册项目 agent。
- 其他请求 → 只进入一次 `poteto-mode`。

混合请求会先拆成明确任务，每个任务只路由一次。

### 直接使用 poteto-mode

```text
/poteto-mode 修复这个 bug，先复现，再修复并做运行时验证
```

原有的 playbooks、principles、`poteto-agent` 和 `orch` 状态实现保持可用。

### 在项目中使用任务级 MCP

1. 在消费项目的 `.claude/agents/` 中定义 agent。
2. 在 agent 的 inline `mcpServers` 中配置任务专用 server，不把它作为父会话的常驻 `.mcp.json` 配置。
3. 新开会话，让 Claude Code 发现该 agent。
4. 通过 `/ryuuji-ai-skill` 派发匹配任务。子代理启动时连接 MCP，结束时断开，主会话只接收结果摘要或产物路径。

完整的 agent 示例、工具白名单和首次连接等待方式见 [`scoped-mcp.md`](./skills/ryuuji-ai-skill/references/scoped-mcp.md)。已有的常驻 MCP 不受影响。

## 设计思路

### 薄入口，单次路由

`ryuuji-ai-skill` 只维护扩展触发条件和路径。命中 RyuuAI 扩展时只执行该扩展；其他请求只交给一次 poteto-mode，不重复选择 playbook。

### 渐进披露

扩展 skill 使用 `disable-model-invocation: true`。需要时才读取正文、references 或脚本，避免所有说明同时进入上下文。

### 子代理拥有任务级 MCP 生命周期

inline server 随子代理启动而连接、随子代理结束而断开。父会话保留自己的常驻 MCP，主流程负责路由、状态、审批和共享写入。

### 状态与编排复用 poteto

持久化状态、任务队列、ledger 和 frontier 继续使用 `skills/poteto-mode/scripts/orch/`，不新增平行的状态系统。

### 仓库独立维护

RyuuAISkill 是独立的公开仓库，不设置指向原 fork 的上游同步，也不包含 `sync-pstack`。pstack 的来源说明和 MIT 许可继续保留，但不构成仓库同步关系。

## 目录

```text
skills/
  ryuuji-ai-skill/     # 统一入口和 scoped MCP 约定
  storage-audit/       # 只读存储审计扩展
  poteto-mode/         # poteto 编排、playbooks 和状态脚本
  principle-*/         # poteto 原则叶子 skills
agents/                # pstack 子代理定义
tests/scoped-mcp/      # 本地 MCP 生命周期测试
docs/guide/            # pstack 使用指南
```

## 验证

在仓库根目录运行：

```bash
npx --yes bun install --cwd skills/poteto-mode/scripts --frozen-lockfile
npx --yes bun test --cwd skills/poteto-mode/scripts
npx --yes bun run --cwd skills/poteto-mode/scripts typecheck
node tests/scoped-mcp/run.mjs
```

storage-audit 的 quick 只读采集示例：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "skills/storage-audit/scripts/collect.ps1" -Target "D:/path/to/audit" -Mode quick
```

采集器只在系统临时目录写 JSON，不删除或整理目标目录。

## 许可与来源

本仓库使用 [MIT License](./LICENSE)。

仓库包含来自 pstack 的 skills、playbooks、agents 和相关文档，并保留 poteto 名称以维持使用兼容性。pstack 的来源包括 [`backnotprop/pstack`](https://github.com/backnotprop/pstack) 和 [`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack)。
