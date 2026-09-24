#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
evidence=${1:?usage: rex-report-judge.sh <evidence.json> <judgment.json>}
answer=${2:?usage: rex-report-judge.sh <evidence.json> <judgment.json>}
[ -f "$evidence" ] || { echo "no evidence at $evidence" >&2; exit 1; }

persona=$(python3 - "$repo_dir/codex/agents/rex.toml" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r'developer_instructions = """\n(.*)"""\s*$', s, re.S)
if not m:
    sys.exit('could not read Rex persona')
print(m.group(1))
PY
)

prompt=$(mktemp)
stderr_log=$(mktemp)
trap 'rm -f "$prompt" "$stderr_log"' EXIT
{
  printf '%s\n\n' "$persona"
  printf 'Read the structured Rex report evidence at %s. Judge only the requested scope.\n' "$evidence"
  printf 'The contentSources path may be read only when query.contentAnalysis is true.\n'
  printf 'If contentAnalysis is false, do not read raw transcripts. Treat metric patterns as observations, not established habits.\n'
  printf 'Do not estimate human work time from session elapsed time or infer intervention causation.\n'
  printf 'Return ONLY one JSON object with {"summary": string, "findings": array}. Each finding needs label, status (metric-observation or established-behavior), sessions (known IDs), evidence (objects with session and reference), and caveat.\n'
  printf 'Use established-behavior only with explicit content opt-in and transcript message references. Use metric-observation for metrics-only evidence. If evidence does not support a diagnosis, return an empty findings array and explain uncertainty in summary. No markdown fences.\n'
} > "$prompt"

if ! codex exec --cd "$repo_dir" --sandbox read-only -o "$answer" "$(cat "$prompt")" \
  < /dev/null > /dev/null 2> "$stderr_log"; then
  echo "Rex judgment failed:" >&2
  tail -20 "$stderr_log" >&2
  exit 1
fi
node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(typeof x.summary!=="string"||!Array.isArray(x.findings))process.exit(2)' "$answer"
