# 生态模式参考表 — storage-audit

> Phase 1 统计缓存、Phase 2 身份、Phase 3 判定时查阅。
> **严格 L1** 才是零风险默认可删；条件 L1 必须先过锁文件/非交付物检查。

## 1. 严格 L1（目录名命中即可，仍须注明重建代价）

| 生态 | 目录 | 重建与代价 |
|---|---|---|
| Unity | `Library/`、`Temp/`、`obj/`、`Logs/`、`MemoryCaptures/`、`Recordings/`（均须同级 `ProjectSettings/`） | 关编辑器后删；重开全量导入，大工程可达数十分钟。`Library` 常占工程 30%–70% |
| Unreal | `Intermediate/`、`DerivedDataCache/`（须同级 `*.uproject`） | 关编辑器后删；shader/cook 缓存重建耗时 |
| Godot | `.godot/`、`.import/`（须同级 `project.godot`） | 重开编辑器再导入 |
| Node | `node_modules/`、`.next/`、`.nuxt/`、`.turbo/`、`.parcel-cache/`、`.cache/`、`coverage/`（须同级 `package.json`） | `npm/pnpm/yarn install`；构建缓存再 build |
| .NET | `bin/`、`obj/`、`.vs/`、`TestResults/`（须同级 `*.sln`/`*.csproj`，或 Unity `ProjectSettings/`） | `dotnet restore/build` 或 VS 重开 |
| Java | `target/`、`.gradle/`（须同级 `pom.xml` / `build.gradle*` / `settings.gradle`） | `mvn` / `gradle` rebuild。IDEA `out/` 见条件 L1 |
| Python | `__pycache__/`、`.pytest_cache/`、`.mypy_cache/`、`.ruff_cache/` | 自动再生。`*.egg-info/` 由模型按名补判，脚本不扫 |
| Rust | `target/`（须同级 `Cargo.toml`） | `cargo build`（重编译耗时） |
| Go | 无严格 L1（`pkg/mod` 见 machine 全局缓存） | — |
| C/C++ | `cmake-build-*/` | 再 cmake/build |
| Android | 工程内 `.gradle/`（须同级 `build.gradle*`） | 再构建。`build/` 见条件 L1 |
| iOS | `DerivedData/`（须同级 `*.xcodeproj` / `*.xcworkspace`） | Xcode 再构建 |
| 通用 | `*.tmp`、`Thumbs.db`、`.DS_Store`、`desktop.ini` | 无代价 |
| 通用 | 含 `CACHEDIR.TAG` 文件的目录（自声明缓存，ncdu 惯例） | 应用可再生；仍注明来源应用 |

> 采集脚本**不会**仅凭目录名把 `Library/`、`bin/` 划进 `caches[]`：必须命中上表的同级工程标记。`Library/` 与 Unity 全局 UPM cache（`%LOCALAPPDATA%/Unity/cache`）分开统计，见 machine-hotspots。

## 2. 条件 L1（默认不进「可立即回收」）

必须**全部**满足才可升为可删，否则列为问用户或不可动。

| 路径 | 升格条件 | 反例 |
|---|---|---|
| `.idea/` | 身份字段已写入采集 JSON；用户确认不需要 IDE 布局 | 未提取 `.idea.<真名>` 之前 **禁止**建议删除 |
| `UserSettings/`（Unity） | 用户不在乎本机布局/上次场景 | 团队若纳入版本库则保留 |
| `.venv/`、`venv/` | 存在 `requirements.txt` / `pyproject.toml` / `Pipfile` | 可能含未提交的本地包 |
| `vendor/`（Go） | 存在 `go.mod` | 无 mod 的 vendor 可能是唯一依赖副本 |
| `Pods/` | 存在 `Podfile.lock` | — |
| `dist/`、`build/`、`out/` | 存在 `package.json` / `pom.xml` / `build.gradle`，且路径不含 `release`/`shipping`/`交付` | 可能是唯一交付物或 IDEA 输出 |
| `Binaries/`（Unreal） | 用户确认不是打包产物、且工程可从源码重编 | 发行拷贝 / 预编译插件不可删 |
| `Build/`（Unity） | 用户确认不是发行包 | 可能是要留的 Player 构建 |
| `packages/`（NuGet 旧格式） | 存在 `packages.config` 或可 `nuget restore` | — |
| `.vscode/` | 一般保留（轻量、含 launch 配置） | 不要当缓存清 |

**永远不是 L1（工程本体）**

`Assets/`、`src/`、`lib/`、`Packages/`（Unity 依赖声明）、`ProjectSettings/`、`package.json`、`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`Cargo.toml`、`Cargo.lock`、`go.mod`、`pyproject.toml`、`*.sln`、`*.csproj`、`ProjectVersion.txt`、`Content/`（Unreal）、`*.uproject`

Unity 自动生成的 `*.csproj`/`*.sln` 也 **不要**划进 L1：与真实 .NET 工程无法用文件名可靠区分。

## 3. 工程身份（血缘）

| 生态 | 文件 | 字段 | 抽取 |
|---|---|---|---|
| Unity | `ProjectSettings/ProjectSettings.asset` | `productName`（可能 `\uXXXX`，先解码） | 只读含该字段的行 |
| Unity | `ProjectSettings/ProjectVersion.txt` | `m_EditorVersion` | 首行即可 |
| 任意 | `.idea/` | 子目录 `.idea.<真名>` | 列目录名，勿读仓库 |
| Node | `package.json` | `name`、`version` | 只读前 40 行 |
| Rust | `Cargo.toml` | `[package] name` | 只读前 30 行 |
| Python | `pyproject.toml` | `name` | 只读前 40 行 |
| .NET | `*.sln` / `*.csproj` | 文件名 | 列名不读正文 |
| Unreal | `*.uproject` | `Description`/`EngineAssociation` 可选 | 文件名即项目名 |
| Godot | `project.godot` | `config/name` | 只读含该字段的行 |
| 通用 | `.git/config` | `url` | 同 remote 即同源 |

规则：

- `productName` 相同 → 同一产品线的不同快照/分支
- `.idea.<同名>` 但顶层目录名不同 → 改名复制，同族
- 包内 `.idea` 指向某工程，磁盘上另有该名/该 productName → 包与目录同族
- `\uXXXX` 先解码再比较

## 4. 压缩包 ↔ 目录（L2）

只读中央目录，不要解压。

- zip：.NET `ZipFile.OpenRead` 或 `unzip -l`；条目 Length 合计 ≈ 解压态大小
- 7z/rar：有 `7z` 才列清单；否则未验证

判定冗余对还需：

1. 顶层名相同 **或** 身份字段相同
2. 不是唯一副本
3. 正本：keep-root > 身份+当前态目录 > 用户确认；mtime 只辅助
4. 量级差 >2×：仍可能同工程（例如包不含 Library），必须在报告注明差异，不得假装「已完全对应」

抽读仅限包内身份文件的头部（最多 1MB；如 `ProjectVersion.txt`、`ProjectSettings.asset` 片段）。不整包解压。

## 5. 文件名分析会漏掉的模式

| 模式 | 识别 |
|---|---|
| `A.zip` 内部实为工程 B | 顶层条目 + `.idea`/`productName`，忽略 zip 文件名 |
| 孪生包（不同名、近大小、同日） | 未压缩大小 + 条目数 + 抽顶层 |
| `A/A/A` 空壳 | 逐层列目录，0 条目即噪声 |
| 目录内同时有 `X/`、`X.zip`、`X_YYYYMMDD.zip` | 顶层 `*.zip/*.7z/*.rar` 必扫 |
| 交付目录里的包与工程同源 | 包内身份 ↔ 工程身份 |

## 6. 版本控制

无 `.git` 的工程群 = zip 快照堆积根因，project 报告必须写一句。有 git 不自动等于「可删工作副本」。
