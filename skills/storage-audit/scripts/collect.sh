#!/usr/bin/env bash
# storage-audit 只读采集（Unix / macOS）
# 不删除、不写目标目录；JSON 写到 ${TMPDIR:-/tmp}，stdout 仅输出该路径。
set -u

MODE="project"
TARGET=""
KEEP_ROOT=""
MAX_ARCHIVES=80
MAX_CACHES=200
MAX_PROJECTS=80

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --keep-root) KEEP_ROOT="${2:-}"; shift 2 ;;
    --max-archives) MAX_ARCHIVES="${2:-80}"; shift 2 ;;
    --max-caches) MAX_CACHES="${2:-200}"; shift 2 ;;
    --max-projects) MAX_PROJECTS="${2:-80}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  quick|project|machine) ;;
  *) echo '{"schema":"storage-audit-collect/1","error":"invalid mode"}'; exit 2 ;;
esac

if [ "$MODE" != "machine" ] && [ -z "$TARGET" ]; then
  echo '{"schema":"storage-audit-collect/1","error":"target required for quick/project"}'
  exit 2
fi

if [ -n "$TARGET" ] && [ ! -e "$TARGET" ]; then
  echo "{\"schema\":\"storage-audit-collect/1\",\"error\":\"target not found\"}"
  exit 2
fi

TMPDIR="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${TMPDIR}/storage-audit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
WARN="$WORK/warnings.txt"
: > "$WARN"
PARTIAL=0
OS="$(uname -s 2>/dev/null || echo unix)"

warn() { printf '%s\n' "$1" >> "$WARN"; }

bytes_of() {
  # 单独调用 du。GNU: du -sb；BSD/macOS 无 -b，退回 du -sk * 1024
  if [ -f "$1" ]; then
    wc -c < "$1" 2>/dev/null | tr -d ' '
    return
  fi
  if du -sb "$1" >/dev/null 2>&1; then
    du -sb "$1" 2>/dev/null | awk '{print $1}'
  else
    du -sk "$1" 2>/dev/null | awk '{print $1 * 1024}'
  fi
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1" 2>/dev/null ||
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

TARGET_RES=""
if [ -n "$TARGET" ]; then
  TARGET_RES="$(cd "$TARGET" 2>/dev/null && pwd)"
  if [ -z "$TARGET_RES" ]; then TARGET_RES="$TARGET"; fi
fi

KEEP_RES=""
if [ -n "$KEEP_ROOT" ] && [ -e "$KEEP_ROOT" ]; then
  KEEP_RES="$(cd "$KEEP_ROOT" 2>/dev/null && pwd)"
fi

DISK_FREE=""
DISK_USED=""
DISK_ROOT=""
DF_PATH="${TARGET_RES:-/}"
if df -kP "$DF_PATH" >/dev/null 2>&1; then
  DISK_ROOT="$(df -kP "$DF_PATH" | awk 'NR==2 {print $6}')"
  DISK_FREE="$(df -kP "$DF_PATH" | awk 'NR==2 {print $4*1024}')"
  DISK_USED="$(df -kP "$DF_PATH" | awk 'NR==2 {print $3*1024}')"
elif df -k "$DF_PATH" >/dev/null 2>&1; then
  DISK_ROOT="$(df -k "$DF_PATH" | awk 'NR==2 {print $NF}')"
  DISK_FREE="$(df -k "$DF_PATH" | awk 'NR==2 {print $4*1024}')"
  DISK_USED="$(df -k "$DF_PATH" | awk 'NR==2 {print $3*1024}')"
fi

SEVENZIP=""
if command -v 7z >/dev/null 2>&1; then SEVENZIP="$(command -v 7z)"; fi
TAR_OK=0
command -v tar >/dev/null 2>&1 && TAR_OK=1
GIT_OK=0
command -v git >/dev/null 2>&1 && GIT_OK=1
UNZIP_OK=0
command -v unzip >/dev/null 2>&1 && UNZIP_OK=1

CACHES_FILE="$WORK/caches.jsonl"
ARCH_FILE="$WORK/archives.jsonl"
PROJ_FILE="$WORK/projects.jsonl"
TOP_FILE="$WORK/toplevel.jsonl"
GIT_FILE="$WORK/git.txt"
NOISE_FILE="$WORK/noise.jsonl"
HOT_FILE="$WORK/hotspots.jsonl"
LARGE_FILE="$WORK/largefiles.jsonl"
: > "$CACHES_FILE"
: > "$ARCH_FILE"
: > "$PROJ_FILE"
: > "$TOP_FILE"
: > "$GIT_FILE"
: > "$NOISE_FILE"
: > "$HOT_FILE"
: > "$LARGE_FILE"

CACHE_NAMES="Library Temp obj Logs MemoryCaptures Recordings Intermediate DerivedDataCache .godot .import node_modules .next .nuxt .turbo .parcel-cache .cache coverage bin .vs TestResults target .gradle __pycache__ .pytest_cache .mypy_cache .ruff_cache cmake-build-debug cmake-build-release DerivedData"

# 严格 L1 缓存目录与 .git 不深入：压缩包/工程/噪声扫描跳过其内部（缓存本身在 caches[] 统计）
SKIP_RE=""
for _n in $CACHE_NAMES .git; do
  _e="${_n//./\\.}"
  if [ -z "$SKIP_RE" ]; then SKIP_RE="/$_e(/|$)"; else SKIP_RE="$SKIP_RE|/$_e(/|$)"; fi
done
skip_path() { printf '%s' "$1" | grep -qE "$SKIP_RE"; }

cache_ok() {
  parent="$1"
  name="$2"
  case "$name" in
    Library|Temp|Logs|MemoryCaptures|Recordings)
      [ -d "$parent/ProjectSettings" ]
      ;;
    bin|.vs|TestResults)
      [ -d "$parent/ProjectSettings" ] && return 0
      ls "$parent"/*.sln >/dev/null 2>&1 && return 0
      ls "$parent"/*.csproj >/dev/null 2>&1 && return 0
      return 1
      ;;
    obj)
      [ -d "$parent/ProjectSettings" ] && return 0
      ls "$parent"/*.sln >/dev/null 2>&1 && return 0
      ls "$parent"/*.csproj >/dev/null 2>&1 && return 0
      return 1
      ;;
    node_modules|.next|.nuxt|.turbo|.parcel-cache|.cache|coverage)
      [ -f "$parent/package.json" ]
      ;;
    target)
      [ -f "$parent/Cargo.toml" ] && return 0
      [ -f "$parent/pom.xml" ] && return 0
      return 1
      ;;
    .gradle)
      [ -f "$parent/pom.xml" ] && return 0
      [ -f "$parent/build.gradle" ] && return 0
      [ -f "$parent/build.gradle.kts" ] && return 0
      [ -f "$parent/settings.gradle" ] && return 0
      return 1
      ;;
    Intermediate|DerivedDataCache)
      ls "$parent"/*.uproject >/dev/null 2>&1
      ;;
    .godot|.import)
      [ -f "$parent/project.godot" ]
      ;;
    __pycache__|.pytest_cache|.mypy_cache|.ruff_cache|cmake-build-debug|cmake-build-release)
      return 0
      ;;
    DerivedData)
      ls "$parent"/*.xcodeproj >/dev/null 2>&1 && return 0
      ls "$parent"/*.xcworkspace >/dev/null 2>&1 && return 0
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

cache_eco() {
  name="$1"
  parent="$2"
  case "$name" in
    Library|Temp|Logs|MemoryCaptures|Recordings) echo unity ;;
    bin|.vs|TestResults) echo dotnet ;;
    obj)
      if [ -d "$parent/ProjectSettings" ]; then echo unity; else echo dotnet; fi
      ;;
    node_modules|.next|.nuxt|.turbo|.parcel-cache|.cache|coverage) echo node ;;
    target)
      if [ -f "$parent/Cargo.toml" ]; then echo rust; else echo java; fi
      ;;
    .gradle) echo java ;;
    Intermediate|DerivedDataCache) echo unreal ;;
    .godot|.import) echo godot ;;
    __pycache__|.pytest_cache|.mypy_cache|.ruff_cache) echo python ;;
    cmake-build-debug|cmake-build-release) echo cmake ;;
    DerivedData) echo xcode ;;
    *) echo unknown ;;
  esac
}

probe_cache() {
  root="$1"
  n=0
  consider() {
    p="$1"
    if [ -e "$p" ]; then
      leaf="$(basename "$p")"
      parent="$(dirname "$p")"
      cache_ok "$parent" "$leaf" || return 0
      b="$(bytes_of "$p" || true)"
      [ -z "$b" ] && PARTIAL=1
      eco="$(cache_eco "$leaf" "$parent")"
      printf '{"path":%s,"pattern":%s,"eco":%s,"bytes":%s}\n' "$(json_escape "$p")" "$(json_escape "$leaf")" "$(json_escape "$eco")" "${b:-null}" >> "$CACHES_FILE"
      n=$((n + 1))
    fi
  }
  # ncdu 惯例：目录内含 CACHEDIR.TAG 即自声明为缓存
  consider_tag() {
    d="$1"
    if [ -f "$d/CACHEDIR.TAG" ]; then
      b="$(bytes_of "$d" || true)"
      [ -z "$b" ] && PARTIAL=1
      printf '{"path":%s,"pattern":"CACHEDIR.TAG","eco":"cachedirtag","bytes":%s}\n' "$(json_escape "$d")" "${b:-null}" >> "$CACHES_FILE"
      n=$((n + 1))
    fi
  }
  for name in $CACHE_NAMES; do
    [ "$n" -ge "$MAX_CACHES" ] && { PARTIAL=1; warn "caches-truncated"; return; }
    consider "$root/$name"
  done
  consider_tag "$root"
  if [ -d "$root" ]; then
    for d in "$root"/*; do
      [ -d "$d" ] || continue
      if skip_path "$d"; then continue; fi
      consider_tag "$d"
      for name in $CACHE_NAMES; do
        [ "$n" -ge "$MAX_CACHES" ] && { PARTIAL=1; warn "caches-truncated"; return; }
        consider "$d/$name"
      done
      for d2 in "$d"/*; do
        [ -d "$d2" ] || continue
        if skip_path "$d2"; then continue; fi
        consider_tag "$d2"
        for name in $CACHE_NAMES; do
          [ "$n" -ge "$MAX_CACHES" ] && { PARTIAL=1; warn "caches-truncated"; return; }
          consider "$d2/$name"
        done
      done
    done
  fi
}

list_top() {
  root="$1"
  if [ ! -d "$root" ]; then return; fi
  # 不用 ls -la 解析；按目录项逐个 du；进程替换避免子 shell 吞掉 PARTIAL
  while IFS= read -r p; do
    name="$(basename "$p")"
    kind="file"
    [ -d "$p" ] && kind="dir"
    case "$name" in
      *.zip|*.7z|*.rar) kind="archive" ;;
    esac
    b="$(bytes_of "$p" || true)"
    [ -z "$b" ] && PARTIAL=1
    mt="$(date -u -r "$p" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo null)"
    mt_json="null"
    [ "$mt" != "null" ] && mt_json="$(json_escape "$mt")"
    printf '{"path":%s,"name":%s,"bytes":%s,"mtime":%s,"kind":%s}\n' \
      "$(json_escape "$p")" "$(json_escape "$name")" "${b:-null}" "$mt_json" "$(json_escape "$kind")" >> "$TOP_FILE"
  done < <(find "$root" -mindepth 1 -maxdepth 1 \( -type d -o -type f \) 2>/dev/null)
}
inspect_zip() {
  python3 - "$1" <<'PY'
import json, os, re, sys, zipfile
path = sys.argv[1]
out = {
    "path": path,
    "format": path.rsplit(".", 1)[-1].lower(),
    "bytes": None,
    "entryCount": None,
    "uncompressedBytes": None,
    "topEntries": [],
    "identityHints": [],
    "listingPreview": None,
}
try:
    out["bytes"] = os.path.getsize(path)
except OSError:
    pass
if out["format"] != "zip":
    print(json.dumps(out, ensure_ascii=False))
    raise SystemExit(0)
try:
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        out["entryCount"] = len(infos)
        out["uncompressedBytes"] = sum(i.file_size for i in infos)
        seen = []
        hints = []
        for i in infos:
            fn = i.filename.replace("\\", "/")
            first = fn.split("/", 1)[0]
            if first and first not in seen:
                seen.append(first)
            m = re.search(r"(?:^|/)\.idea/\.idea\.([^/]+)", fn)
            if m:
                hints.append("idea:" + m.group(1))
            tag = None
            if fn.endswith("ProjectSettings/ProjectVersion.txt"):
                tag = "editorVersion"
            elif fn.endswith("ProjectSettings/ProjectSettings.asset"):
                tag = "productName"
            elif fn.endswith("package.json"):
                tag = "package"
            if not tag:
                continue
            try:
                data = z.read(i.filename)[:1048576].decode("utf-8", "replace")
            except Exception:
                data = ""
            if tag == "editorVersion":
                mm = re.search(r"m_EditorVersion:\s*(\S+)", data)
                if mm:
                    hints.append("editorVersion:" + mm.group(1))
            elif tag == "productName":
                mm = re.search(r"productName:\s*(.+)", data)
                if mm:
                    raw = mm.group(1).strip()
                    raw = re.sub(r"\\u([0-9A-Fa-f]{4})", lambda x: chr(int(x.group(1), 16)), raw)
                    hints.append("productName:" + raw)
            elif tag == "package":
                mm = re.search(r'"name"\s*:\s*"([^"]+)"', data)
                if mm:
                    hints.append("package:" + mm.group(1))
        out["topEntries"] = seen[:20]
        out["identityHints"] = sorted(set(hints))
except Exception:
    pass
print(json.dumps(out, ensure_ascii=False))
PY
}

# 7z/rar：有 7z 时用 -slt 清单解析出条目数/未压缩合计/顶层条目/.idea 提示
# 清单走临时文件而非环境变量：巨型压缩包会超 env 长度上限
inspect_7z() {
  slt_file="$WORK/slt.txt"
  "$2" l -slt "$1" 2>/dev/null > "$slt_file"
  if [ ! -s "$slt_file" ]; then warn "7z-list-failed:$1"; fi
  SLT_FILE="$slt_file" python3 - "$1" <<'PY'
import json, os, re, sys
path = sys.argv[1]
slt = ""
try:
    with open(os.environ["SLT_FILE"], encoding="utf-8", errors="replace") as f:
        slt = f.read()
except Exception:
    pass
out = {
    "path": path,
    "format": path.rsplit(".", 1)[-1].lower(),
    "bytes": None,
    "entryCount": None,
    "uncompressedBytes": None,
    "topEntries": [],
    "identityHints": [],
    "listingPreview": None,
}
try:
    out["bytes"] = os.path.getsize(path)
except OSError:
    pass
count = 0
total = 0
tops = []
hints = set()
cur = None
preview = []
for line in slt.splitlines():
    m = re.match(r"Path = (.+)$", line)
    if m:
        cur = m.group(1).replace("\\", "/")
        if len(preview) < 20:
            preview.append(cur)
        im = re.search(r"(?:^|/)\.idea/\.idea\.([^/]+)", cur)
        if im:
            hints.add("idea:" + im.group(1))
        continue
    m = re.match(r"Size = (\d+)$", line)
    if m and cur:
        count += 1
        total += int(m.group(1))
        first = cur.split("/", 1)[0]
        if first and first not in tops:
            tops.append(first)
if slt:
    out["entryCount"] = count
    out["uncompressedBytes"] = total
    out["topEntries"] = tops[:20]
    out["identityHints"] = sorted(hints)
    out["listingPreview"] = "\n".join(preview)
print(json.dumps(out, ensure_ascii=False))
PY
}

scan_archives() {
  root="$1"
  n=0
  while IFS= read -r p; do
    skip_path "$p" && continue
    n=$((n + 1))
    if [ "$n" -gt "$MAX_ARCHIVES" ]; then
      PARTIAL=1
      warn "archives-truncated"
      break
    fi
    ext="${p##*.}"
    ext="$(printf '%s' "$ext" | tr 'A-Z' 'a-z')"
    if [ "$ext" = "zip" ]; then
      inspect_zip "$p" >> "$ARCH_FILE"
      continue
    fi
    if [ -n "$SEVENZIP" ]; then
      inspect_7z "$p" "$SEVENZIP" >> "$ARCH_FILE"
      continue
    fi
    b="$(bytes_of "$p" || true)"
    printf '{"path":%s,"format":%s,"bytes":%s,"entryCount":null,"uncompressedBytes":null,"topEntries":[],"identityHints":[],"listingPreview":null}\n' \
      "$(json_escape "$p")" "$(json_escape "$ext")" "${b:-null}" >> "$ARCH_FILE"
  done < <(find "$root" -maxdepth 3 \( -iname '*.zip' -o -iname '*.7z' -o -iname '*.rar' \) -type f 2>/dev/null)
}

first_match() {
  file="$1"
  pat="$2"
  [ -f "$file" ] || return 0
  python3 -c "import re,sys
p=sys.argv[2]
try:
    lines=open(sys.argv[1],encoding='utf-8',errors='replace')
except Exception:
    raise SystemExit(0)
r=re.compile(p)
for line in lines:
    m=r.search(line)
    if m:
        print(m.group(1) if m.lastindex else m.group(0))
        break
" "$file" "$pat" 2>/dev/null
}

scan_projects() {
  root="$1"
  n=0
  # 自身 + 两层子目录
  paths="$root"
  if [ -d "$root" ]; then
    for d in "$root"/*; do
      [ -d "$d" ] || continue
      skip_path "$d" && continue
      paths="$paths
$d"
      for d2 in "$d"/*; do
        [ -d "$d2" ] || continue
        skip_path "$d2" && continue
        paths="$paths
$d2"
      done
    done
  fi
  printf '%s\n' "$paths" | while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    [ "$dir" != "$root" ] && skip_path "$dir" && continue
    eco=""
    product=""
    editor=""
    idea=""
    pkg=""
    pkgver=""
    remote=""
    hasgit="false"
    uproject=""
    godot=""
    if [ -f "$dir/ProjectSettings/ProjectSettings.asset" ] || [ -f "$dir/ProjectSettings/ProjectVersion.txt" ]; then
      eco="unity"
      product="$(first_match "$dir/ProjectSettings/ProjectSettings.asset" 'productName:\s*(.+)$')"
      product="$(python3 -c "import re,sys; s=sys.argv[1]; print(re.sub(r'\\\\u([0-9A-Fa-f]{4})', lambda m: chr(int(m.group(1),16)), s) if s else '')" "$product" 2>/dev/null || printf '%s' "$product")"
      editor="$(first_match "$dir/ProjectSettings/ProjectVersion.txt" 'm_EditorVersion:\s*(\S+)')"
    fi
    if [ -f "$dir/package.json" ]; then
      [ -z "$eco" ] && eco="node"
      pkg="$(first_match "$dir/package.json" '"name"\s*:\s*"([^"]+)"')"
      pkgver="$(first_match "$dir/package.json" '"version"\s*:\s*"([^"]+)"')"
    fi
    if [ -f "$dir/Cargo.toml" ]; then
      [ -z "$eco" ] && eco="rust"
      pkg="$(first_match "$dir/Cargo.toml" '^name\s*=\s*"([^"]+)"')"
    fi
    if [ -f "$dir/pyproject.toml" ]; then
      [ -z "$eco" ] && eco="python"
      pkg="$(first_match "$dir/pyproject.toml" '^name\s*=\s*"([^"]+)"')"
    fi
    up="$(find "$dir" -maxdepth 1 -name '*.uproject' -type f 2>/dev/null | head -1)"
    if [ -n "$up" ]; then
      [ -z "$eco" ] && eco="unreal"
      uproject="$(basename "$up")"
    fi
    if [ -f "$dir/project.godot" ]; then
      [ -z "$eco" ] && eco="godot"
      godot="$(first_match "$dir/project.godot" 'config/name\s*=\s*"([^"]+)"')"
    fi
    sln="$(find "$dir" -maxdepth 1 -name '*.sln' -type f 2>/dev/null | head -1)"
    if [ -n "$sln" ] && [ -z "$eco" ]; then eco="dotnet"; fi
    if [ -d "$dir/.idea" ]; then
      idea="$(find "$dir/.idea" -maxdepth 1 -type d -name '.idea.*' 2>/dev/null | head -1)"
      [ -n "$idea" ] && idea="$(basename "$idea")"
    fi
    if [ -e "$dir/.git" ]; then
      hasgit="true"
      remote="$(first_match "$dir/.git/config" 'url\s*=\s*(.+)$')"
    fi
    if [ -z "$eco" ] && [ -z "$idea" ] && [ "$hasgit" = "false" ] && [ -z "$pkg" ]; then
      continue
    fi
    n=$((n + 1))
    if [ "$n" -gt "$MAX_PROJECTS" ]; then
      warn "projects-truncated"
      break
    fi
    python3 - "$dir" "$eco" "$product" "$editor" "$idea" "$pkg" "$pkgver" "$remote" "$hasgit" "$uproject" "$godot" "$PROJ_FILE" <<'PY'
import json, sys
keys = ["path","eco","productName","editorVersion","ideaName","packageName","packageVersion","gitRemote","hasGit","uproject","godotName"]
vals = sys.argv[1:12]
obj = dict(zip(keys, vals))
obj["hasGit"] = vals[8] == "true"
for k in obj:
    if obj[k] == "":
        obj[k] = None
with open(sys.argv[12], "a", encoding="utf-8") as f:
    f.write(json.dumps(obj, ensure_ascii=False) + "\n")
PY
  done
}

scan_git() {
  root="$1"
  find "$root" -maxdepth 3 -name '.git' 2>/dev/null | while IFS= read -r g; do
    d="$(dirname "$g")"
    printf '%s\n' "$d" >> "$GIT_FILE"
  done
}

scan_noise() {
  root="$1"
  inspect() {
    dir="$1"
    leaf="$(basename "$dir")"
    if [ -d "$dir/$leaf" ]; then
      printf '{"path":%s,"reason":"nested-same"}\n' "$(json_escape "$dir/$leaf")" >> "$NOISE_FILE"
    fi
    if [ -d "$dir" ]; then
      cnt="$(find "$dir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
      skip_empty=0
      for cn in $CACHE_NAMES; do
        [ "$leaf" = "$cn" ] && skip_empty=1 && break
      done
      if [ "$cnt" = "0" ] && [ "$skip_empty" -eq 0 ]; then
        printf '{"path":%s,"reason":"empty"}\n' "$(json_escape "$dir")" >> "$NOISE_FILE"
      fi
    fi
    case "$leaf" in
      *备份*|*backup*|old|*_old*|新建文件夹|*Copy*|*副本*)
        printf '{"path":%s,"reason":"backup-name"}\n' "$(json_escape "$dir")" >> "$NOISE_FILE"
        ;;
    esac
  }
  inspect "$root"
  if [ -d "$root" ]; then
    for d in "$root"/*; do
      [ -d "$d" ] || continue
      skip_path "$d" && continue
      inspect "$d"
      for d2 in "$d"/*; do
        [ -d "$d2" ] || continue
        skip_path "$d2" && continue
        inspect "$d2"
      done
    done
  fi
}

# 与目录树正交的最大文件：深度 ≤2、>100MB、跳过缓存目录
scan_large_files() {
  root="$1"
  [ -d "$root" ] || return
  find "$root" -maxdepth 3 -type f -size +104857599c 2>/dev/null | while IFS= read -r p; do
    skip_path "$p" && continue
    b="$(bytes_of "$p" || true)"
    [ -z "$b" ] && continue
    mt="$(date -u -r "$p" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo null)"
    mt_json="null"
    [ "$mt" != "null" ] && mt_json="$(json_escape "$mt")"
    printf '%s\t%s\t%s\n' "$b" "$p" "$mt_json" >> "$LARGE_FILE.raw"
  done
  # 体积降序取前 50
  if [ -s "$LARGE_FILE.raw" ]; then
    sort -rn -k1,1 "$LARGE_FILE.raw" | head -50 | while IFS=$'\t' read -r b p mt_json; do
      printf '{"path":%s,"name":%s,"bytes":%s,"mtime":%s}\n' \
        "$(json_escape "$p")" "$(json_escape "$(basename "$p")")" "$b" "$mt_json" >> "$LARGE_FILE"
    done
  fi
}

add_hot() {
  name="$1"
  path="$2"
  tier="$3"
  kind="$4"
  [ -e "$path" ] || return 0
  b="$(bytes_of "$path" || true)"
  [ -z "$b" ] && PARTIAL=1
  printf '{"name":%s,"path":%s,"tier":%s,"kind":%s,"bytes":%s}\n' \
    "$(json_escape "$name")" "$(json_escape "$path")" "$(json_escape "$tier")" "$(json_escape "$kind")" "${b:-null}" >> "$HOT_FILE"
}

scan_hotspots() {
  home="${HOME:-/}"
  add_hot npm-cache "$home/.npm" green pkg-cache
  add_hot pip-cache "$home/.cache/pip" green pkg-cache
  add_hot pnpm "$home/.local/share/pnpm" green pkg-cache
  add_hot gradle "$home/.gradle/caches" green pkg-cache
  add_hot maven "$home/.m2/repository" green pkg-cache
  add_hot cargo "$home/.cargo/registry" green pkg-cache
  add_hot go-mod "$home/go/pkg/mod" green pkg-cache
  add_hot ollama "$home/.ollama" yellow model
  add_hot huggingface "$home/.cache/huggingface" yellow model
  if [ "$(uname -s)" = "Darwin" ]; then
    add_hot xcode-dd "$home/Library/Developer/Xcode/DerivedData" green build-cache
    add_hot pip-macos "$home/Library/Caches/pip" green pkg-cache
  fi
}

if [ "$MODE" = "machine" ]; then
  scan_hotspots
  if [ -n "$TARGET_RES" ]; then
    list_top "$TARGET_RES"
  fi
fi

if [ -n "$TARGET_RES" ] && [ "$MODE" != "machine" ]; then
  list_top "$TARGET_RES"
  probe_cache "$TARGET_RES"
  scan_large_files "$TARGET_RES"
fi

if [ -n "$TARGET_RES" ] && [ "$MODE" = "project" ]; then
  scan_archives "$TARGET_RES"
  scan_projects "$TARGET_RES"
  scan_git "$TARGET_RES"
  scan_noise "$TARGET_RES"
fi

OUT="${TMPDIR}/storage-audit-collect-$(date +%Y%m%d-%H%M%S).json"
export WORK WARN OUT MODE TARGET_RES KEEP_RES OS DISK_ROOT DISK_FREE DISK_USED SEVENZIP TAR_OK GIT_OK PARTIAL \
  CACHES_FILE ARCH_FILE PROJ_FILE TOP_FILE GIT_FILE NOISE_FILE HOT_FILE LARGE_FILE

python3 <<'PY'
import json, os, pathlib

def read_jsonl(path):
    p = pathlib.Path(path)
    if not p.exists() or p.stat().st_size == 0:
        return []
    rows = []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows

def read_lines(path):
    p = pathlib.Path(path)
    if not p.exists() or p.stat().st_size == 0:
        return []
    return [ln.strip() for ln in p.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]

def i(v):
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None

result = {
    "schema": "storage-audit-collect/1",
    "mode": os.environ.get("MODE"),
    "target": os.environ.get("TARGET_RES") or None,
    "keepRoot": os.environ.get("KEEP_RES") or None,
    "os": os.environ.get("OS"),
    "generatedAt": __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "disk": {
        "root": os.environ.get("DISK_ROOT") or None,
        "freeBytes": i(os.environ.get("DISK_FREE")),
        "usedBytes": i(os.environ.get("DISK_USED")),
    },
    "tools": {
        "sevenZip": bool(os.environ.get("SEVENZIP")),
        "tar": os.environ.get("TAR_OK") == "1",
        "git": os.environ.get("GIT_OK") == "1",
    },
    "topLevel": read_jsonl(os.environ["TOP_FILE"]),
    "caches": read_jsonl(os.environ["CACHES_FILE"]),
    "archives": read_jsonl(os.environ["ARCH_FILE"]),
    "projects": read_jsonl(os.environ["PROJ_FILE"]),
    "gitRoots": read_lines(os.environ["GIT_FILE"]),
    "structureNoise": read_jsonl(os.environ["NOISE_FILE"]),
    "machineHotspots": read_jsonl(os.environ["HOT_FILE"]),
    "largeFiles": read_jsonl(os.environ["LARGE_FILE"]),
    "warnings": read_lines(os.environ["WARN"]),
    "partial": os.environ.get("PARTIAL") == "1",
}

# 正本约束写入数据模型：命中 keep-root 的条目永不可作为被删方
keep = os.environ.get("KEEP_RES")
if keep:
    kr = keep.rstrip("/")
    for key in ("topLevel", "caches", "archives", "projects", "largeFiles"):
        for e in result.get(key, []):
            p = e.get("path") or ""
            if p == kr or p.startswith(kr + "/"):
                e["underKeepRoot"] = True
out = os.environ["OUT"]
pathlib.Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(out)
PY

status=$?
if [ $status -ne 0 ]; then
  echo '{"schema":"storage-audit-collect/1","error":"python3 required to emit JSON"}' >&2
  exit 1
fi
echo "storage-audit: wrote $OUT" >&2
