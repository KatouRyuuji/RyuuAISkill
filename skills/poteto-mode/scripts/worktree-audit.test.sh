#!/usr/bin/env bash
set -euo pipefail

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
audit="$scripts_dir/worktree-audit.sh"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/worktree-audit-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home"

# Keep the audit offline and provide only the jq operations it uses.
cat > "$tmp/bin/origin" <<'SH'
#!/usr/bin/env bash
exit 1
SH
cat > "$tmp/bin/gh" <<'SH'
#!/usr/bin/env bash
command cat <<'JSON'
[
  {"number": 1, "state": "OPEN", "headRefName": "open"},
  {"number": 2, "state": "CLOSED", "headRefName": "closed"},
  {"number": 3, "state": "MERGED", "headRefName": "merged"}
]
JSON
SH
cat > "$tmp/bin/jq" <<'PY'
#!/usr/bin/env python3
import json, sys
if "-r" in sys.argv:
    arg = sys.argv.index("--arg")
    branch = sys.argv[arg + 2]
    with open(sys.argv[-1], encoding="utf-8") as f:
        rows = json.load(f)
    for row in rows:
        if row["head"] == branch:
            print("#%s/%s" % (row["number"], row["state"]))
else:
    rows = json.load(sys.stdin)
    normalized = []
    for row in rows:
        if "headRefName" in row:
            normalized.append({
                "number": row["number"],
                "state": row["state"].lower(),
                "head": row["headRefName"],
            })
        else:
            normalized.append({
                "number": row["number"],
                "state": row["status"].lower(),
                "head": row["headRef"],
            })
    json.dump(normalized, sys.stdout)
PY
chmod +x "$tmp/bin/origin" "$tmp/bin/gh" "$tmp/bin/jq"

git init -q --initial-branch=main "$tmp/repo"
git -C "$tmp/repo" config user.name Test
git -C "$tmp/repo" config user.email test@example.invalid
printf 'base\n' > "$tmp/repo/file.txt"
git -C "$tmp/repo" add file.txt
git -C "$tmp/repo" commit -q -m base

# All PR branches have commits outside main, so only explicit PR state can make
# the merged row safe. The ancestor branch exercises merge-base detection.
for branch in open closed merged; do
  git -C "$tmp/repo" worktree add -q -b "$branch" "$tmp/wt-$branch" main
  printf '%s\n' "$branch" >> "$tmp/wt-$branch/file.txt"
  git -C "$tmp/wt-$branch" add file.txt
  git -C "$tmp/wt-$branch" commit -q -m "$branch"
done
git -C "$tmp/repo" worktree add -q -b ancestor "$tmp/wt-ancestor" main

output="$(HOME="$tmp/home" PATH="$tmp/bin:$PATH" bash "$audit" -b main "$tmp/repo")"
printf '%s\n' "$output"

assert_row() {
  local branch="$1" expected_merged="$2" expected_pr="$3" expected_bucket="$4"
  local row size age merged dirty remote pr last bucket path wt_path
  wt_path="$(git -C "$tmp/wt-$branch" rev-parse --show-toplevel)"
  row="$(printf '%s\n' "$output" | awk -F '\t' -v path="$wt_path" '$9 == path {print}')"
  [ -n "$row" ] || { echo "missing worktree row: $branch" >&2; exit 1; }
  IFS=$'\t' read -r size age merged dirty remote pr last bucket path <<< "$row"
  [ "$merged" = "$expected_merged" ] || { echo "$branch MERGED=$merged" >&2; exit 1; }
  [ "$pr" = "$expected_pr" ] || { echo "$branch PR=$pr" >&2; exit 1; }
  [ "$bucket" = "$expected_bucket" ] || { echo "$branch BUCKET=$bucket" >&2; exit 1; }
}

assert_row open no '#1/open' hold-open-pr
assert_row closed no '#2/closed' review
assert_row merged no '#3/merged' safe
assert_row ancestor YES '-' safe
printf 'ok: open, closed-unmerged, merged-PR, and merged-base classifications\n'
