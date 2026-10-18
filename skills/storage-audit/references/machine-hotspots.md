# 本机热点 — storage-audit machine 模式

> 只扫下列已知路径（存在才测体积）。不要递归整个用户配置目录。
> 绿 = 默认可重建；黄 = 列体积、默认不可动；红 = 不建议进入删除讨论。

体积计入 `machineHotspots[]`。绿档可进 `reclaimImmediate`（注明重下/重建代价）；黄/红不得计入。

脚本未扫、需要时由模型手工补测：VS `ComponentModelCache`、macOS Docker Desktop 数据目录、Linux `/var/cache/apt`（常需权限）。

## Windows

路径中的环境变量在采集脚本里展开。

### 绿：包管理器与工具缓存

| 名称 | 路径 |
|---|---|
| npm | `%LOCALAPPDATA%\npm-cache` |
| yarn | `%LOCALAPPDATA%\Yarn\Cache` |
| pnpm | `%LOCALAPPDATA%\pnpm\store`、`%LOCALAPPDATA%\pnpm-store` |
| NuGet | `%USERPROFILE%\.nuget\packages`、`%LOCALAPPDATA%\NuGet\v3-cache` |
| bun | `%LOCALAPPDATA%\bun` |
| yarn berry | `%LOCALAPPDATA%\Yarn\Berry\Cache` |
| pip | `%LOCALAPPDATA%\pip\Cache`、`%LOCALAPPDATA%\pip\cache` |
| cargo | `%USERPROFILE%\.cargo\registry`、`%USERPROFILE%\.cargo\git` |
| Go module | `%USERPROFILE%\go\pkg\mod` |
| Gradle | `%USERPROFILE%\.gradle\caches` |
| Maven | `%USERPROFILE%\.m2\repository` |
| Unity UPM | `%LOCALAPPDATA%\Unity\cache` |
| Temp | `%TEMP%`（与 `%LOCALAPPDATA%\Temp` 常为同一路径，脚本按解析后路径去重） |
| 编辑器缓存 | `%APPDATA%\Cursor\Cache`、`%APPDATA%\Cursor\CachedData`、`%APPDATA%\Claude\Cache`、`%APPDATA%\Code\Cache` |

### 黄：模型、会话、可能含用户数据

| 名称 | 路径 | 说明 |
|---|---|---|
| Ollama | `%USERPROFILE%\.ollama` | 权重，删了要重下 |
| HuggingFace | `%USERPROFILE%\.cache\huggingface` | 同上 |
| Torch | `%USERPROFILE%\.cache\torch` | 同上 |
| LM Studio | `%USERPROFILE%\.cache\lm-studio` | 同上 |
| rustup | `%USERPROFILE%\.rustup` | 工具链，删了要重装 target |
| Continue | `%USERPROFILE%\.continue` | 含索引/会话 |
| Claude CLI | `%USERPROFILE%\.claude` | 会话/设置，不是浏览器 Cache |
| Cursor 用户态 | `%APPDATA%\Cursor\User` | 设置与历史 |
| npm 全局包 | `%APPDATA%\npm` | 全局命令，确认后再动 |

### 虚拟盘（单独成行，不要当普通缓存）

| 名称 | 典型路径 |
|---|---|
| Docker WSL | `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`、`%LOCALAPPDATA%\Docker\wsl\data\ext4.vhdx`、`%LOCALAPPDATA%\Docker\wsl\main\ext4.vhdx` |
| WSL 商店发行版 | `%LOCALAPPDATA%\Packages\*\LocalState\ext4.vhdx` |
| WSL 新布局 | `%LOCALAPPDATA%\wsl\*\ext4.vhdx` |

报告要求：

1. 报宿主文件 `Length`（逻辑大小）。能读到「占用」则并列
2. 写明：在发行版/Docker **内部**删除文件后，VHDX **不会自动缩小**
3. compact 仅作为用户确认后的下一步说明：先停 Docker，`wsl --shutdown`，管理员 `Optimize-VHD` 或 `diskpart compact`。Home 版可能无 `Optimize-VHD`
4. **禁止**代为 shutdown、prune、compact

### 红：默认不碰

用户文档、桌面、照片、音乐、OneDrive/网盘同步根、微信/企业微信文件与数据库、邮箱 PST、`C:\Windows`、`Windows.old`（系统回滚）、回收站本体。允许**报告** `Windows.old` 体积，处置必须是「问用户」。

## macOS（machine 在非 Windows 时）

绿：`~/Library/Developer/Xcode/DerivedData`、`~/.npm`、`~/Library/Caches/pip`、`~/.gradle/caches`、`~/.m2/repository`、`~/.cargo/registry`。不要把整个 `~/Library/Caches` 当绿档（里面混着登录态）。Docker Desktop 数据目录脚本不扫，需手工补测。

黄：`~/.ollama`、`~/.cache/huggingface`、`~/Library/Application Support/Cursor`、容器 `~/Library/Containers`（只报最大项，不建议清）。

红：照片图库、iMessage、钥匙串、Time Machine 本地快照。删文件后 APFS 快照可能导致可用空间不立刻上升——报告里解释，不代删快照。

## Linux

绿：`~/.cache/pip`、`~/.npm`、`~/.local/share/pnpm`、`~/.gradle/caches`、`~/.m2/repository`、`~/.cargo/registry`、`~/go/pkg/mod`、`/var/cache/apt`（需权限，失败则跳过）。

黄：`~/.ollama`、`~/.cache/huggingface`、`~/.local/share/docker` 或 `/var/lib/docker`。

虚拟盘：Linux 上 Docker 一般不是 VHDX；用 `docker system df`（只读）报内部占用，不执行 prune。
