# plan.json 填写示例

`scaffold` 生成计划后，只改下面四处。其余字段由脚本维护，不要动。

设定：本机检测到 `claude-code` 和 `codex`。Claude 正本里有三条规则，Codex 有一条。

## 改动前的样子

```json
{
  "recommendation": "A",
  "analysis": [
    { "agent": "claude-code", "keep": [], "drop": [], "rationale": "TODO: classify existing rules before preview" },
    { "agent": "codex", "keep": [], "drop": [], "rationale": "TODO: classify existing rules before preview" }
  ],
  "branches": {
    "A": { "claude-code": "", "codex": "" },
    "B": { "claude-code": "", "codex": "" },
    "C": { "claude-code": "", "codex": "" }
  }
}
```

## 填好之后

```json
{
  "recommendation": "C",
  "analysis": [
    {
      "agent": "claude-code",
      "keep": ["总是用中文回答我", "先理解需求"],
      "drop": ["可读性优先"],
      "rationale": "语言和需求理解两条正本没有，保留；可读性优先已被正本覆盖，丢弃"
    },
    {
      "agent": "codex",
      "keep": ["总是用中文回答我"],
      "drop": [],
      "rationale": "原文只写「用中文」，改写成与正本一致的完整句后保留"
    }
  ],
  "branches": {
    "A": { "claude-code": "", "codex": "" },
    "B": {
      "claude-code": "# 语言\n- 总是用中文回答我。\n\n# 需求\n- 先理解需求。\n\n# 质量\n- 可读性优先。\n",
      "codex": "# 语言\n- 总是用中文回答我。\n"
    },
    "C": {
      "claude-code": "# 语言\n- 总是用中文回答我。\n\n# 需求\n- 先理解需求。\n",
      "codex": "# 语言\n- 总是用中文回答我。\n"
    }
  }
}
```

## 五条校验规则

脚本在 `preview` 和 `apply` 前核对下列关系，任一不满足就拒绝。

1. `rationale` 非空，且不以 `TODO` 开头。
2. `keep` 里的每条规则，都能在 `B` 的增量里找到对应句子。
3. `C` 增量里的每条规则，都能在 `keep` 里找到对应句子。
4. `B` 必须包含 `C` 的每一条规则。B 是保守版，只能比 C 多。
5. 同一条规则不能同时出现在 `keep` 和 `drop`。

第 1 条单独核对 `analysis`。第 2 到 5 条核对 `analysis` 与 `branches` 的一致性。匹配忽略标点、空白、大小写和列表符号，允许一条包含另一条。

## 增量写法

`A` 恒为空，脚本强制。`B` 和 `C` 是给该 agent 追加的规则正文。

- 只写规则，不要写正本里已有的内容。
- 不要写 Cursor 的 `alwaysApply` 头，脚本会加。
- 用 `\n` 表示换行，规则行以 `- ` 开头。这两点是脚本识别规则的依据。

`recommendation` 只能是 `A` 或 `C`。`B` 只用来展示「更保守会是什么样」，永远不推荐。
