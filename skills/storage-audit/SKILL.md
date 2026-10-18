---
name: storage-audit
description: 目录冗余与存储空间只读审计。用结构/元数据/轻量身份识别可再生缓存、压缩包-解压冗余、同族多版本；Windows/Unix 双轨；quick/project/machine 三模式。按风险分级给出删除建议与整理方案，绝不主动删除。Triggers on "storage-audit", "存储分析", "冗余分析", "磁盘空间分析", "空间清理建议", "哪些可以删", "整理与存储建议", "Docker占空间", "WSL占用".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
disable-model-invocation: true
---

# Storage Audit — 目录冗余与存储空间审计

对目标做**只读**审计，产出按风险分级的删除建议。核心方法：不读文件正文，用**结构 + 元数据 + 轻量身份标识**推断冗余。内容哈希不是主路径。

本 skill 目录：`SKILL.md`（协议）· `scripts/collect.ps1` · `scripts/collect.sh` · `references/ecosystem-patterns.md` · `references/machine-hotspots.md`

## 核心原则（不可违反）

1. **只读分析，绝不主动删除**——删除/compact/清理缓存永远由用户确认后另行执行
2. **证据先于结论**——判定冗余必须有可陈述证据；禁止仅凭文件名相似
3. **保留清单与删除清单等长**——每条删除建议必须写明保留方及原因；另列 ⛔ 不可动清单
4. **诚实置信度**——实测 / 估算 / 未验证 三者必须分开；估算不得计入「可立即回收」主数字
5. **正本优先于 mtime**——用户指定的正本根 > 身份一致 > 大小同量级 > 时间戳（时间戳只做辅助）
6. **先提取身份，再谈删除**——`.idea/`、工程文件在划入可删之前必须已经采集身份字段
7. **不写目标盘**——采集 JSON 只写系统临时目录；未经用户明确要求，不写 `整理与存储建议.md`

## 输入

| 参数 | 必填 | 说明 |
|---|---|---|
| 目标路径 | quick/project 必填；machine 可空 | 未给则先问。machine 且未给路径时，只扫本机热点 |
| 模式 | 未给则先问 | `quick` / `project` / `machine`，见下 |
| 正本根 keep-root | 选填 | 同族副本一律让路给该目录（rmlint tagged original） |

Windows 路径一律写成 `D:/foo`（正斜杠）。不要对目标目录做写操作。

## 三种模式

| 模式 | 何时用 | 做什么 |
|---|---|---|
| **quick** | 只要体积排行与可再生缓存 | 顶层体积 + 严格 L1 缓存命中 + 磁盘余量。不做血缘、不拆压缩包 |
| **project** | 工程囤积盘、备份盘、zip 快照族 | 现有血缘流程：身份、压缩包中央目录、同族多版本 |
| **machine** | 「C: 为什么满了」、Docker/WSL/AI 缓存 | 扫 [machine-hotspots.md](references/machine-hotspots.md)；**不**把用户文档/聊天库当 L1 |

一次只跑一种主模式。用户要「既整理工程盘又看 C:」时先 project 再 machine，报告分开写回收量。

## OS 与命令

先判断 OS。采集**优先跑脚本**，失败再手工补测。

| OS | 采集脚本 | 体积 | 磁盘余量 | zip 清单 |
|---|---|---|---|---|
| Windows | `scripts/collect.ps1` | 无 junction 时 FSO；有则跳过 ReparsePoint 遍历。禁止 `du` | `Get-PSDrive` | .NET `ZipFile`（只读中央目录） |
| Unix / macOS | `scripts/collect.sh`（需要 `python3` 写 JSON） | `du -sb`，失败则 `du -sk` | `df -kP` | Python `zipfile` / `7z l` |

Windows 禁止依赖 `grep` / `find` / `sed` / `awk` / `du` / `df` / `which`。Git Bash 若被使用：路径必须正斜杠，且 **禁止** `du a a/subdir` 同次调用（inode 去重会静默跳过子目录）。

```powershell
# Windows（Bypass 仅针对本脚本）
powershell -NoProfile -ExecutionPolicy Bypass -File "<本skill>/scripts/collect.ps1" -Target "D:/foo" -Mode project -KeepRoot "D:/foo/Main"
# 可选：-TimeoutSec 900（默认 900；超时则 partial=true，未测项体积留空）
```

```bash
# Unix
bash "<本skill>/scripts/collect.sh" --target /path --mode project --keep-root /path/Main
```

脚本把 JSON 写到临时文件并把路径打在 stdout。读该文件，不要把 GB 级目录当文本读入。

## 工作流

### 0. 对齐输入

路径或模式缺失 → 问用户。不要默认全盘递归。

### 1. 采集（机械，脚本做）

脚本输出契约（`schema: storage-audit-collect/1`）：

- `disk` 余量（实测）
- `topLevel[]` 顶层名 / 体积 / mtime / 文件或目录或压缩包
- `largeFiles[]` 与目录树正交的最大文件（深度 ≤2、>100MB、降序前 50、跳过缓存目录）
- `caches[]` 命中的**严格 L1**（须带工程标记，见 ecosystem-patterns）：路径、体积、`eco`；目录内含 `CACHEDIR.TAG` 文件即自声明缓存（`eco=cachedirtag`）
- 目标可以是单个 `.zip/.7z/.rar`：只采集该包，不扫父目录
- `archives[]` zip/7z/rar：顶层条目、条目数、未压缩合计、体积；能抽则带身份hint（7z/rar 需本机有 `7z`，用 `-slt` 清单解析出结构化字段）
- `projects[]` 身份字段（productName、editorVersion、ideaName、package name、git remote）
- `gitRoots[]`
- `structureNoise[]` 空壳、嵌套同名、`备份`/`old`/`新建文件夹`
- `machineHotspots[]`（machine 模式）
- `tools`（7z / tar / git 是否可用）
- `warnings[]`、`partial`（超时或拒绝访问时为 true）
- 云占位文件（OneDrive `RECALL_ON_DATA_ACCESS`）只报元数据并带 `cloud: true` + warning，**不读内容**（避免审计触发下载）
- 指定 keep-root 时，其树内条目带 `underKeepRoot: true`——**永不可作为被删方**，无正本的冗余组整体降为未验证（rmlint `-km` / dupeGuru reference 语义）

压缩包/工程/噪声/git 扫描不深入严格 L1 缓存目录与 `.git` 内部（缓存体积已在 `caches[]` 统计）。

采集脚本是同步的：结束后再读 JSON。不要在脚本仍在跑时另起一套 `du` 扫同一棵树。`partial=true` 或体积为 null 的项标「估算」。

### 2. 身份与血缘（project 模式；模型做判定）

查阅 [ecosystem-patterns.md](references/ecosystem-patterns.md)。优先级：

1. 工程身份文件（单行字段，勿读全文）
2. `.idea.<真名>`（改名副本的关键线索）
3. 压缩包中央目录 + 必要时抽读包内身份文件（最多读条目头部 1MB，不整包解压）
4. `.git` 覆盖率——无 git 的工程群是 zip 快照堆积的根因，必须点出
5. 结构异常

`.rar`/`.7z`：先看 `tools.sevenZip`。无工具则名称+日期+大小推断，标未验证。

### 3. 判定（现象 × 处置，两轴）

**现象（是什么）** 与 **处置（怎么办）** 分开写，禁止把「空壳」和「同族多版本」塞进同一张「可删表」混排。

| 现象 | 处置默认 | 风险 |
|---|---|---|
| 严格 L1 可再生缓存 | 可删（关编辑器/IDE 后）；注明重建代价 | 零 |
| 条件 L1（`.venv`/`dist`/`vendor`/`.idea`） | 满足锁文件且非交付物才可删；否则不可动或问用户 | 低～中 |
| 压缩包 vs 解压目录（L2） | 留正本，删副本；默认**留目录删包**（目录是当前态） | 低（失去该瞬间回滚点） |
| 同族多版本（L3） | **只给合并建议，不给删除清单**，用户选基线 | 中 |
| 结构噪声 | 空壳/嵌套同名可顺手删；已出现在 `caches[]` 的空目录不要再当 L4 重复计；`<250MB` 杂包单独标，不自动当垃圾 | 低 |
| 全局包缓存（machine） | 可重建，注明重下代价 | 零～低 |
| 本地模型 / 聊天库 / 云盘 | 黄档：列体积，默认不可动 | 中～高 |
| 虚拟盘 VHDX | 先报宿主文件大小；prune ≠ 宿主回缩。compact 只给步骤，不代执行 | 中（需停 Docker/WSL） |
| 内容重复（L5，可选） | 默认关闭 | — |

L2 必须**同时**满足：

1. 包内顶层目录名 = 磁盘目录名，**或** 身份字段确认同工程
2. 已验证不是唯一副本
3. 正本判定：keep-root > 身份一致且目录为更新态 > 用户确认。**mtime 冲突则降为未验证，不得直接进删除清单**
4. 包内条目数/未压缩大小与目录同量级（差 >2× 时注明构成差异，如包无 Library）

同包名不同日期的多个压缩包：内部顶层同项目则旧包为副本候选。名不符实的包（`A.zip` 内实为工程 B）必须单独点名。

### 4. 置信度（票）

一票一项，报告里写票数：

| 票 | 含义 |
|---|---|
| identity | productName / `.idea` / package.json / csproj 等对上 |
| listing | 已读压缩包中央目录（或 7z 清单） |
| size | 未压缩大小或体积同量级（差 ≤2×） |
| keep | 命中用户正本根 |
| recency | mtime/包内日期一致支持正本（仅辅助） |

- L2 **删除建议**：`identity` + `listing`，且 `keep` 或（`size` 且无 mtime 冲突）
- 只有 `recency` 或只有文件名 → 未验证，不得进「可立即回收」
- 条件 L1 缺锁文件 → 未验证

### 5. 回收量去重叠

同一路径只计一次。祖先已被计入则子路径不计。

- 建议删整个工程（罕见，且 L3 默认不删）才把整棵树计入；其下 Library 不再另计
- 默认更常见：L3 只建议合并 → 可立即回收只计该树内的严格 L1 + 被取代压缩包
- 主数字 `reclaimImmediate` = 严格 L1 实测 + 合格 L2 副本实测（去重叠）
- `reclaimIfUserChooses` = 条件 L1 + 用户选基线后可能释放的 L3
- 两者禁止加总后当「能腾 XX G」

### 6. 对话内报告（必须）

1. 模式、目标、正本根、磁盘余量、采集是否 partial
2. 总量盘点表（实测/估算分开）
3. 按现象分组的表：路径 | 大小 | 现象 | 处置 | 保留方 | 票/置信度
4. ⛔ 不可动清单（唯一副本、活跃项目、交付物、黄档数据、`underKeepRoot` 条目）及理由
5. 执行顺序：先严格 L1，再 L2 副本（进回收站，不永久删），最后才讨论 L3。标注 `reclaimImmediate`
6. machine 模式若有 VHDX：写明「内部删除不会自动缩小宿主文件」

**落地文档**：仅当用户明确要求时写入 `<目标>/整理与存储建议.md`（族谱、整理规范、备份策略、git 替代 zip、路线图）。

## 可选 L5（默认关闭）

仅当用户明确要求「找内容完全相同的大文件」时：

- 只对未进入 L1/L2、且 `>100MB` 的文件
- 先按大小分桶，同大小才 `Get-FileHash` / `sha256sum`
- 输出重复组 + 正本（keep-root 或最旧路径）；不自动删

不要全盘哈希，不要做相似图/视频。

## 输出后

询问是否需要（均不主动执行）：

1. dry-run 删除清单（只列路径，优先回收站/`Move-Item` 到隔离目录）
2. 落地整理文档
3. 台账模板 `PROJECTS.md`
4. machine 模式下的 VHDX compact **说明**（需管理员、先 `wsl --shutdown`）

## 禁止

- 自动删除、`docker system prune`、`Optimize-VHD`、`npm cache clean`、一条清空 `~/.cache`
- 把 `.sln` / `.csproj` / `Assets` / `src` / `ProjectSettings` / `package.json` 当 L1
- 未提取身份就建议删 `.idea/`
- 把聊天库、照片库、云盘同步目录、Ollama/HuggingFace **模型权重** 标成零风险
- 向目标目录写采集缓存或报告（除非用户要落地文档）

## 工具陷阱

| 陷阱 | 正确做法 |
|---|---|
| `du dir dir/subdir` 同次 | 分开调用 |
| Windows 反斜杠拼进 bash | `D:/path` |
| 单个 `du /*` 扫大盘 | 脚本按顶层子目录统计；partial 则标估算 |
| 无 7z 硬列 rar/7z | 降置信度 |
| L1 Library + L3 整目录双计 | §5 去重叠 |
| 复制/杀毒改 mtime | mtime 冲突则未验证 |
| `robocopy ... NULL` 当体积工具 | 可能在 cwd 留下 `NULL` 目录；体积用 FSO 或跳过 junction 的遍历 |
| Docker prune 后 C: 仍满 | 报告 VHDX 宿主大小；compact 另说 |
| OneDrive/junction 循环 | 顶层是 junction 则跳过；深度 1–2 发现 junction 则改用不跟随 ReparsePoint 的遍历 |
| 泛名 `bin/` `Library/` | 脚本要求旁有 `.sln`/`.csproj` 或 `ProjectSettings/`，否则不进 `caches[]` |
| `collect.ps1` 中文注释 | 文件必须存为 UTF-8 **with BOM**；无 BOM 时 PS 5.1 按 ANSI(GBK) 误读注释，可能静默吞掉相邻分支 |
