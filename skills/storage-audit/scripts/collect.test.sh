#!/usr/bin/env bash
set -euo pipefail

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
collect_sh="$scripts_dir/collect.sh"
collect_ps1="$scripts_dir/collect.ps1"
real_python="$(command -v python3)"
real_date="$(command -v date)"
export REAL_PYTHON="$real_python" REAL_DATE="$real_date"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/storage-audit-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/sh-output" "$tmp/ps-output"

# Reject ZipFile.read and any unbounded ZipExtFile.read in the embedded ZIP
# inspector. A valid identity hint therefore proves bounded streaming was used.
cat > "$tmp/bin/python3" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "-" ] && [[ "${2:-}" == *.zip ]]; then
  {
    printf '%s\n' \
      'import zipfile' \
      'def _reject_full_read(*args, **kwargs):' \
      '    raise RuntimeError("full ZIP entry read")' \
      'zipfile.ZipFile.read = _reject_full_read' \
      '_zip_entry_read = zipfile.ZipExtFile.read' \
      'def _bounded_read(self, n=-1):' \
      '    if n is None or n < 0 or n > 1048576:' \
      '        raise RuntimeError("unbounded ZIP entry read")' \
      '    return _zip_entry_read(self, n)' \
      'zipfile.ZipExtFile.read = _bounded_read'
    command cat
  } | "$REAL_PYTHON" "$@"
else
  exec "$REAL_PYTHON" "$@"
fi
SH

# Make the legacy seconds-only output name deterministic across all workers.
cat > "$tmp/bin/date" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "+%Y%m%d-%H%M%S" ]; then
  printf '20000101-000000\n'
else
  exec "$REAL_DATE" "$@"
fi
SH
chmod +x "$tmp/bin/python3" "$tmp/bin/date"

mkdir -p "$tmp/zip-target"
"$real_python" - "$tmp/zip-target/large.zip" <<'PY'
import sys, zipfile
payload = b'{"name":"streamed","padding":"' + b'x' * (3 * 1048576) + b'"}'
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("demo/package.json", payload)
PY

zip_out="$(TMPDIR="$tmp/sh-output" PATH="$tmp/bin:$PATH" \
  bash "$collect_sh" --target "$tmp/zip-target" --mode project)"
"$real_python" - "$zip_out" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    result = json.load(f)
archive = result["archives"][0]
assert archive["uncompressedBytes"] > 3 * 1048576
assert "package:streamed" in archive["identityHints"]
print("ok: ZIP identity reads are bounded to 1 MiB")
PY

validate_outputs() {
  local out_dir="$1"
  shift
  "$real_python" - "$out_dir" "$@" <<'PY'
import json, os, sys
out_dir = os.path.normcase(os.path.abspath(sys.argv[1]))
paths = [open(name, encoding="utf-8").read().strip() for name in sys.argv[2:]]
assert len(paths) == 6
assert len(set(paths)) == len(paths), paths
targets = []
for path in paths:
    assert os.path.isfile(path), path
    parent = os.path.normcase(os.path.dirname(os.path.abspath(path)))
    assert parent == out_dir, (path, out_dir)
    with open(path, encoding="utf-8-sig") as f:
        targets.append(json.load(f)["target"])
assert len(set(targets)) == len(targets), targets
print("ok: six concurrent collectors returned unique output paths")
PY
}

pids=""
for i in 1 2 3 4 5 6; do
  mkdir -p "$tmp/sh-target-$i"
  printf '%s\n' "$i" > "$tmp/sh-target-$i/marker.txt"
  (TMPDIR="$tmp/sh-output" PATH="$tmp/bin:$PATH" \
    bash "$collect_sh" --target "$tmp/sh-target-$i" --mode quick \
    > "$tmp/sh-path-$i" 2> "$tmp/sh-log-$i") &
  pids="$pids $!"
done
for pid in $pids; do wait "$pid"; done
validate_outputs "$tmp/sh-output" "$tmp"/sh-path-*

powershell_bin="$(command -v pwsh || command -v powershell || true)"
if [ -z "$powershell_bin" ]; then
  echo "skip: PowerShell is unavailable"
  exit 0
fi

to_windows() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}

# Override Get-Date in the caller scope so the collector also uses a fixed time.
cat > "$tmp/run-fixed-time.ps1" <<'PS1'
param([string]$Collector, [string]$Target)
function Get-Date {
    param([string]$Format)
    $value = [DateTime]::new(2020, 1, 2, 3, 4, 5, [DateTimeKind]::Utc)
    if ($Format) { return $value.ToString($Format) }
    return $value
}
& $Collector -Target $Target -Mode quick
PS1

runner_win="$(to_windows "$tmp/run-fixed-time.ps1")"
collector_win="$(to_windows "$collect_ps1")"
ps_output_win="$(to_windows "$tmp/ps-output")"
pids=""
for i in 1 2 3 4 5 6; do
  mkdir -p "$tmp/ps-target-$i"
  printf '%s\n' "$i" > "$tmp/ps-target-$i/marker.txt"
  target_win="$(to_windows "$tmp/ps-target-$i")"
  (TEMP="$ps_output_win" TMP="$ps_output_win" \
    "$powershell_bin" -NoProfile -ExecutionPolicy Bypass -File "$runner_win" \
    -Collector "$collector_win" -Target "$target_win" \
    > "$tmp/ps-path-$i" 2> "$tmp/ps-log-$i") &
  pids="$pids $!"
done
for pid in $pids; do wait "$pid"; done
validate_outputs "$tmp/ps-output" "$tmp"/ps-path-*
